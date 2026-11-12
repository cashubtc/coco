import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { prepareReplay } from '../../fault-simulation/replay.ts';
import { UnsupportedTraceError, readTrace } from '../../fault-simulation/trace.ts';
import { PlanPreconditionError } from '../../fault-simulation/workload.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8');

const generatedFailure = () => JSON.parse(fixture('v2-generated-seed-2-false-deficit.trace.json'));

describe('replay preparation', () => {
  it('replays a generated plan from its recorded commands and reports that they still regenerate', () => {
    const recorded = generatedFailure();

    const replay = prepareReplay(readTrace(JSON.stringify(recorded)));

    expect(replay.plan.steps).toEqual(recorded.plan.steps);
    expect(replay.provenance).toEqual({
      originalRunId: recorded.runId,
      originalFormat: 'coco-wallet-fault-simulation/trace/v2',
      generator: { seed: 2, version: 1, currentGenerator: 'reproduces' },
    });
  });

  it('keeps recorded commands when the current generator would produce different ones', () => {
    const recorded = generatedFailure();
    // As if an older generator produced these commands: drop two late generated commands.
    recorded.plan.steps.splice(29, 2);
    recorded.plan.generator.version = 0;

    const replay = prepareReplay(readTrace(JSON.stringify(recorded)));

    expect(replay.plan.steps).toEqual(recorded.plan.steps);
    expect(replay.provenance.generator).toMatchObject({ seed: 2, currentGenerator: 'differs' });
  });

  it('refuses a recorded plan whose state preconditions no longer hold', () => {
    const recorded = generatedFailure();
    const sendIndex = recorded.plan.steps.findIndex(
      (step: { kind: string }) => step.kind === 'send',
    );
    recorded.plan.steps.splice(sendIndex, 1);

    expect(() => prepareReplay(readTrace(JSON.stringify(recorded)))).toThrow(PlanPreconditionError);
  });

  it('refuses a step kind this harness cannot execute', () => {
    const recorded = generatedFailure();
    recorded.plan.steps.splice(10, 0, { kind: 'futureFault', mint: 'mint-a' });

    expect(() => prepareReplay(readTrace(JSON.stringify(recorded)))).toThrow(UnsupportedTraceError);
  });

  it('prepares a migrated v1 trace with its migration provenance', () => {
    const replay = prepareReplay(
      readTrace(fixture('v1-receive-lost-response-crash-restart.trace.json')),
    );

    expect(replay.plan.mints).toEqual(['mint-a']);
    expect(replay.provenance).toMatchObject({
      originalFormat: 'coco-wallet-fault-simulation/trace/v1',
    });
    expect(replay.provenance.generator).toBeUndefined();
  });
});

it('preserves explicit recovery mode when validating a recorded plan', () => {
  const trace = readTrace(
    readFileSync(
      new URL(
        '../../fault-simulation/fixtures/v2-generated-faults-explicit-seed-5.trace.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(prepareReplay(trace).plan).toEqual(trace.plan);
});
