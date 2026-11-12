import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildRunReport, mergeCoverage, renderReport } from '../../fault-simulation/report.ts';
import { readTrace, type RecordedTrace } from '../../fault-simulation/trace.ts';

const fixture = (name: string) =>
  readTrace(
    readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8'),
  );

const v1Crash = () => fixture('v1-receive-lost-response-crash-restart.trace.json');
const generatedFailure = () => fixture('v2-generated-seed-2-false-deficit.trace.json');

function withEvents(
  trace: RecordedTrace,
  ...events: { type: string; source?: string; data?: Record<string, unknown> }[]
) {
  const copy = structuredClone(trace);
  for (const event of events) {
    copy.events.push({ seq: copy.events.length + 1, atMs: 0, source: 'harness', ...event });
  }
  return copy;
}

describe('run report', () => {
  it('reports the fault, crash and recovery coverage a controlled interruption actually exercised', () => {
    const report = buildRunReport(v1Crash());

    expect(report.coverage.faults).toEqual({
      fired: { 'POST /v1/swap after_downstream_response/delay': 1 },
      unfired: {},
    });
    expect(report.coverage.crashes).toEqual({
      'SIGKILL mintAcceptedRequest=true persisted=executing': 1,
    });
    expect(report.coverage.restarts).toEqual({ after_crash: 1 });
    expect(report.coverage.recoveryModes).toEqual({ automatic: 1 });
    expect(report.coverage.transport['GET /v1/ws']).toBe(1);
    expect(report.scenario.migratedFrom).toBe('coco-wallet-fault-simulation/trace/v1');
  });

  it('reports a generated failure with its scenario seed, accounting differences and exercised commands', () => {
    const report = buildRunReport(generatedFailure());

    expect(report.scenario).toMatchObject({ scenarioSeed: 2, generatorVersion: 1 });
    expect(report).toMatchObject({ outcome: 'wallet_failure', expectationMet: false });
    expect(report.signature.findings).toEqual([
      'value_deficit mint=mint-b',
      'wallet_value_mismatch mint=mint-b wallet=carol',
    ]);
    expect(report.accounting.unexplained).toEqual({ 'mint-a': 0, 'mint-b': 1 });
    expect(report.accounting.findings.map((finding) => finding.message)).toEqual([
      '1 funded value is unaccounted for at mint-b',
      'carol holds 48 at mint-b, attributed 49',
    ]);
    expect(report.coverage.commands).toMatchObject({
      'receive:rejected': 3,
      'reclaim:rejected': 3,
      'raceReclaim:completed': 3,
    });
    expect(report.coverage.races).toEqual({
      'lead=recipient winner=recipient': 2,
      'unled winner=recipient': 1,
    });
    expect(report.coverage.restarts).toEqual({ graceful: 3 });
    expect(report.coverage.checkpoints).toEqual({ pass: 2, wallet_failure: 1 });
    // No fault was installed: the report must not claim fault or crash coverage.
    expect(report.coverage.faults).toEqual({ fired: {}, unfired: {} });
    expect(report.coverage.crashes).toEqual({});
  });

  it('reports an installed fault that never fired as uncovered', () => {
    const trace = withEvents(generatedFailure(), {
      type: 'fault_installed',
      source: 'gateway',
      data: {
        step: 3,
        ruleId: 'http-rule-9',
        mint: 'mint-a',
        kind: 'dropRequest',
        method: 'POST',
        path: '/v1/melt',
      },
    });

    const report = buildRunReport(trace);

    expect(report.coverage.faults.unfired).toEqual({ 'dropRequest POST /v1/melt @mint-a': 1 });
    expect(renderReport(report)).toContain('dropRequest POST /v1/melt @mint-a');
  });

  it('keeps event types it does not interpret visible instead of dropping them', () => {
    const trace = withEvents(
      generatedFailure(),
      { type: 'websocket_disconnected', data: { mint: 'mint-a' } },
      { type: 'websocket_disconnected', data: { mint: 'mint-b' } },
    );

    expect(buildRunReport(trace).additionalEvents).toEqual({ websocket_disconnected: 2 });
  });

  it('states that clean-state replay needs no private inputs and which ones aid diagnosis', () => {
    expect(buildRunReport(generatedFailure()).privateInputs).toEqual({
      requiredForCleanStateReplay: [],
      retainedForDiagnosis: {
        'alice.walletSeed': 'private/alice.seed',
        'alice.store': 'private/alice.sqlite',
        'bob.walletSeed': 'private/bob.seed',
        'bob.store': 'private/bob.sqlite',
        'carol.walletSeed': 'private/carol.seed',
        'carol.store': 'private/carol.sqlite',
      },
    });
  });

  it('aggregates exercised coverage across runs', () => {
    const merged = mergeCoverage([
      buildRunReport(v1Crash()).coverage,
      buildRunReport(generatedFailure()).coverage,
    ]);

    expect(merged.runs).toBe(2);
    expect(merged.restarts).toEqual({ after_crash: 1, graceful: 3 });
    expect(merged.checkpoints).toEqual({ pass: 3, wallet_failure: 1 });
    expect(merged.faults.fired).toEqual({ 'POST /v1/swap after_downstream_response/delay': 1 });
  });
});
