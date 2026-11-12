import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compareRuns, failureSignature } from '../../fault-simulation/report.ts';
import { readTrace, type RecordedTrace } from '../../fault-simulation/trace.ts';

const fixture = (name: string) =>
  readTrace(
    readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const generatedFailure = () => fixture('v2-generated-seed-2-false-deficit.trace.json');

/** A finished run of the given trace's plan with a different outcome and final verdict. */
function rerun(
  trace: RecordedTrace,
  result: { outcome: string; expectationMet: boolean; reason?: string },
  findings: Record<string, unknown>[] = [],
  extraEvents: { type: string; data: Record<string, unknown> }[] = [],
): RecordedTrace {
  const events = [
    ...extraEvents.map((event, index) => ({
      seq: index + 1,
      atMs: 0,
      source: 'harness',
      ...event,
    })),
    {
      seq: extraEvents.length + 1,
      atMs: 1,
      source: 'checker',
      type: 'verdict',
      data: { step: 9, status: result.outcome, findings },
    },
  ];
  return {
    ...structuredClone(trace),
    runId: `${trace.runId}-rerun`,
    events,
    result: { ...result },
  };
}

describe('failure identity', () => {
  it('identifies a failure by outcome and the failing findings it reported, scoped by mint and Wallet', () => {
    expect(failureSignature(generatedFailure())).toEqual({
      outcome: 'wallet_failure',
      findings: ['value_deficit mint=mint-b', 'wallet_value_mismatch mint=mint-b wallet=carol'],
    });
  });

  it('reads the identity of a migrated v1 failure from its recorded verdict', () => {
    expect(failureSignature(fixture('v1-negative-control-no-restart.trace.json'))).toEqual({
      outcome: 'wallet_failure',
      findings: ['outcome_unmet wallet=bob', 'value_deficit mint=mint-a'],
    });
  });

  it('identifies a command failure by the failing command kind, not its step index or message', () => {
    const trace = generatedFailure();
    const failed = rerun(
      trace,
      { outcome: 'wallet_failure', expectationMet: false, reason: 'step 15: op abc rejected' },
      [],
      [{ type: 'command_failed', data: { step: 15, message: 'op abc rejected' } }],
    );

    expect(failureSignature(failed)).toEqual({
      outcome: 'wallet_failure',
      findings: [],
      commandFailure: 'receive',
    });
  });

  it('identifies an unresolved run by its error class and unresolved findings', () => {
    const unresolved = rerun(
      generatedFailure(),
      {
        outcome: 'unresolved',
        expectationMet: false,
        reason: 'ScenarioPreconditionError: Faults never fired: http-rule-1',
      },
      [{ code: 'missing_evidence', severity: 'unresolved', wallet: 'bob', message: 'x' }],
    );

    expect(failureSignature(unresolved)).toEqual({
      outcome: 'unresolved',
      findings: ['missing_evidence wallet=bob'],
      reasonClass: 'ScenarioPreconditionError',
    });
  });
});

it('recognizes a migrated single-mint failure in current mint-scoped evidence without rewriting history', () => {
  const original = fixture('v1-negative-control-no-restart.trace.json');
  original.result!.expectationMet = false;
  const before = JSON.stringify(original.events);
  const replay = structuredClone(original);
  delete replay.migratedFrom;
  for (const event of replay.events) {
    if (event.type !== 'verdict') continue;
    for (const finding of event.data!.findings as { code: string; mint?: string }[]) {
      if (finding.code === 'value_deficit') finding.mint = 'mint-a';
    }
  }
  expect(compareRuns(original, replay).status).toBe('reproduced');
  expect(JSON.stringify(original.events)).toBe(before);
});

describe('replay comparison', () => {
  const original = generatedFailure();
  const sameFailure = rerun(original, { outcome: 'wallet_failure', expectationMet: false }, [
    {
      code: 'wallet_value_mismatch',
      severity: 'failure',
      mint: 'mint-b',
      wallet: 'carol',
      amount: 2,
    },
    { code: 'value_deficit', severity: 'failure', mint: 'mint-b', amount: 2 },
  ]);

  it('reproduces only with the same failure identity, whatever the amounts', () => {
    expect(compareRuns(original, sameFailure)).toMatchObject({
      status: 'reproduced',
      original: 'unresolved',
    });
  });

  it('never treats a passing rerun as a fix: the original failure stays unresolved', () => {
    const passing = rerun(original, { outcome: 'pass', expectationMet: true });

    expect(compareRuns(original, passing)).toMatchObject({
      status: 'not_reproduced',
      original: 'unresolved',
    });
  });

  it('does not count an unrelated failure as a reproduction', () => {
    const unrelated = rerun(original, { outcome: 'wallet_failure', expectationMet: false }, [
      { code: 'value_deficit', severity: 'failure', mint: 'mint-a', amount: 1 },
    ]);

    expect(compareRuns(original, unrelated).status).toBe('different_failure');
  });

  it('treats an infrastructure failure as inconclusive', () => {
    const broken = rerun(original, { outcome: 'infrastructure_failure', expectationMet: false });

    expect(compareRuns(original, broken).status).toBe('inconclusive');
  });

  it('distinguishes consistent and diverging replays of a run that met its expectation', () => {
    const passed = rerun(original, { outcome: 'pass', expectationMet: true });
    const failed = rerun(original, { outcome: 'wallet_failure', expectationMet: false }, [
      { code: 'value_deficit', severity: 'failure', mint: 'mint-a', amount: 1 },
    ]);

    expect(compareRuns(passed, passed)).toMatchObject({
      status: 'consistent',
      original: 'expectation_met',
    });
    expect(compareRuns(passed, failed).status).toBe('diverged');
  });

  it('lists component versions that differ between the original and the replay', () => {
    const replay = structuredClone(sameFailure);
    replay.components = {
      ...original.components,
      coco: { commit: 'f'.repeat(40), dirty: false },
      replayOf: original.runId,
    };

    expect(compareRuns(original, replay).componentDifferences).toEqual([
      'coco.commit',
      'coco.dirty',
    ]);
  });
});
