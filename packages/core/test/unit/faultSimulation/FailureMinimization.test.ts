import { describe, expect, it } from 'bun:test';
import { minimizeFailure, type CandidateObservation } from '../../fault-simulation/minimize.ts';
import type { FailureSignature } from '../../fault-simulation/report.ts';
import type { ScenarioPlan, ScenarioStep } from '../../fault-simulation/scenarios.ts';
import { planWorkload } from '../../fault-simulation/workload.ts';

const lostResponse: FailureSignature = {
  outcome: 'wallet_failure',
  findings: ['outcome_unmet wallet=bob', 'value_deficit mint=mint-a'],
};
const unrelated: FailureSignature = {
  outcome: 'wallet_failure',
  findings: ['value_deficit mint=mint-b'],
};
const passed: FailureSignature = { outcome: 'pass', findings: [] };

/** A generated-looking failing plan: the lost-response core surrounded by unrelated commands. */
const failingPlan: ScenarioPlan = {
  id: 'generated-seed-7',
  description: 'generated',
  expect: 'pass',
  recoveryMode: 'automatic',
  recoveryDeadlineMs: 60_000,
  wallets: ['alice', 'bob', 'carol'],
  mints: ['mint-a', 'mint-b'],
  generator: {
    seed: 7,
    wallets: ['alice', 'bob', 'carol'],
    mints: ['mint-a', 'mint-b'],
    commands: 8,
    initialFunding: 64,
    maxAmount: 32,
    checkpointEvery: 8,
    version: 1,
  },
  steps: [
    { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
    { kind: 'fund', wallet: 'carol', mint: 'mint-b', amount: 64 },
    { kind: 'send', wallet: 'carol', mint: 'mint-b', amount: 16, token: 'c1' },
    { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'a1' },
    { kind: 'receive', wallet: 'alice', token: 'c1' },
    { kind: 'restart', wallet: 'carol' },
    { kind: 'checkpoint' },
    { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
    { kind: 'receive', wallet: 'bob', token: 'a1', crashWhenFaultFires: true },
    { kind: 'heal' },
    { kind: 'reclaim', token: 'c1' },
    { kind: 'checkpoint' },
  ],
};

const index = (plan: ScenarioPlan, kind: ScenarioStep['kind'], wallet?: string) =>
  plan.steps.findIndex(
    (step) => step.kind === kind && (!wallet || ('wallet' in step && step.wallet === wallet)),
  );

/**
 * Stand-in for a real run with a known bug: Bob's crashed Receive is never recovered unless he is
 * restarted. Every plan it is asked to run must be executable: it throws otherwise.
 */
function buggyWorld(
  overrides: (plan: ScenarioPlan) => FailureSignature | undefined = () => undefined,
) {
  const executed: ScenarioPlan[] = [];
  const run = async (plan: ScenarioPlan): Promise<CandidateObservation> => {
    planWorkload(plan);
    const crash = index(plan, 'receive', 'bob');
    const fault = index(plan, 'withholdResponse');
    const heal = index(plan, 'heal');
    if (crash >= 0 && !(fault >= 0 && fault < crash && heal > crash)) {
      throw new Error('Minimizer ran a plan without the fault and healing its crash depends on');
    }
    executed.push(plan);
    const signature =
      overrides(plan) ?? (crash >= 0 && index(plan, 'restart', 'bob') < 0 ? lostResponse : passed);
    return { signature, evidence: `runs/candidate-${executed.length}/trace.json` };
  };
  return { run, executed };
}

describe('failure minimization', () => {
  it('rejects an unexpectedly passing negative control before running candidates', async () => {
    const trace = readTrace(
      readFileSync(
        new URL(
          '../../fault-simulation/fixtures/v1-negative-control-no-restart.trace.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    trace.plan.expect = 'detected-failure';
    trace.result = { ...trace.result, outcome: 'pass', expectationMet: false };
    const original = structuredClone(trace);
    let runs = 0;

    await expect(
      minimizeFailure(
        { plan: trace.plan, signature: failureSignature(trace), runId: trace.runId },
        async () => {
          runs++;
          return { signature: passed };
        },
        { maxRuns: 40 },
      ),
    ).rejects.toThrow('Cannot minimize a passing run');
    expect(runs).toBe(0);
    expect(trace).toEqual(original);
  });

  it('removes irrelevant commands while keeping preconditions and the same failure', async () => {
    const original = structuredClone(failingPlan);
    const world = buggyWorld();

    const result = await minimizeFailure(
      { plan: failingPlan, signature: lostResponse, runId: 'original-run' },
      world.run,
      { maxRuns: 40 },
    );

    expect(result.status).toBe('minimized');
    expect(result.plan.steps).toEqual([
      { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
      { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'a1' },
      { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
      { kind: 'receive', wallet: 'bob', token: 'a1', crashWhenFaultFires: true },
      { kind: 'heal' },
      { kind: 'checkpoint' },
    ]);
    expect(result.keptSteps).toEqual([0, 3, 7, 8, 9, 11]);
    // The minimized plan is new data; the original plan and its identity are kept as evidence.
    expect(failingPlan).toEqual(original);
    expect(result.original).toEqual({ runId: 'original-run', signature: lostResponse });
    // A minimized plan is no longer what the generator produced; its origin is recorded instead.
    expect(result.plan.generator).toBeUndefined();
    expect(result.plan.id).toBe('generated-seed-7-minimized');
    expect(result.derivedFrom).toEqual({ runId: 'original-run', generator: failingPlan.generator });
    // The accepted plan was itself observed to reproduce.
    const accepted = result.attempts.filter((attempt) => attempt.result === 'reproduced').at(-1);
    expect(accepted?.keptSteps).toEqual(result.keptSteps);
    expect(result.runs).toBe(world.executed.length);
  });

  it('keeps a step whose removal turns the failure into an unrelated one', async () => {
    const world = buggyWorld((plan) =>
      index(plan, 'send', 'carol') >= 0 && index(plan, 'reclaim') < 0 ? unrelated : undefined,
    );

    const result = await minimizeFailure(
      { plan: failingPlan, signature: lostResponse, runId: 'original-run' },
      world.run,
      { maxRuns: 60 },
    );

    expect(result.status).toBe('minimized');
    expect(result.plan.steps).toContainEqual({ kind: 'reclaim', token: 'c1' });
    expect(result.attempts.some((attempt) => attempt.result === 'different_failure')).toBe(true);
    for (const attempt of result.attempts.filter((a) => a.result === 'different_failure')) {
      expect(attempt.signature).toEqual(unrelated);
    }
  });

  it('leaves a failure that does not reproduce unresolved and unchanged', async () => {
    const result = await minimizeFailure(
      { plan: failingPlan, signature: lostResponse, runId: 'original-run' },
      async () => ({ signature: passed, evidence: 'runs/rerun/trace.json' }),
      { maxRuns: 40 },
    );

    expect(result.status).toBe('unreproduced');
    expect(result.plan).toEqual(failingPlan);
    expect(result.runs).toBe(1);
    expect(result.attempts).toEqual([
      {
        keptSteps: failingPlan.steps.map((_, step) => step),
        result: 'not_reproduced',
        signature: passed,
        evidence: 'runs/rerun/trace.json',
      },
    ]);
  });

  it('stops at its run budget with the smallest plan observed to reproduce', async () => {
    const world = buggyWorld();

    const result = await minimizeFailure(
      { plan: failingPlan, signature: lostResponse, runId: 'original-run' },
      world.run,
      { maxRuns: 3 },
    );

    expect(result.status).toBe('budget_exhausted');
    expect(result.runs).toBe(3);
    const reproducing = result.attempts
      .filter((attempt) => attempt.result === 'reproduced')
      .map((attempt) => attempt.keptSteps);
    expect(reproducing).toContainEqual(result.keptSteps);
  });

  it('treats a candidate run that throws as not reproducing', async () => {
    const world = buggyWorld();
    let calls = 0;

    const result = await minimizeFailure(
      { plan: failingPlan, signature: lostResponse, runId: 'original-run' },
      async (plan) => {
        calls++;
        if (calls === 2) throw new Error('mint container did not start');
        return world.run(plan);
      },
      { maxRuns: 40 },
    );

    expect(result.attempts[1]).toMatchObject({
      result: 'error',
      error: 'mint container did not start',
    });
    expect(result.status).toBe('minimized');
  });
});
