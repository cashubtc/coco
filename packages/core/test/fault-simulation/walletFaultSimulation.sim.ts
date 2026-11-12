/**
 * Real-mint wallet fault simulation scenarios.
 *
 * Each scenario starts its own pinned mint containers, a pinned Cashu Fault Lab HTTP gateway per
 * mint and Wallet processes with persistent SQLite stores. This file is deliberately outside the
 * default `*.test.ts` glob; run it with `bun run test:fault-simulation` from the repository root.
 *
 * `COCO_FAULT_SIM_SEEDS` (comma-separated unsigned 32-bit integers) selects the scenario seeds of
 * the generated workloads; the default is a small fixed set.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { replayScenario, runScenario, type ScenarioRun } from './runner.ts';
import { scenarios, type ScenarioStep } from './scenarios.ts';
import { generateWorkload, type WorkloadOptions } from './workload.ts';

const scenarioTimeoutMs = 180_000;
const workloadTimeoutMs = 420_000;

const seeds = (process.env.COCO_FAULT_SIM_SEEDS ?? '1,2')
  .split(',')
  .map((seed) => Number(seed.trim()));

const generatedWorkload = (seed: number): WorkloadOptions => ({
  seed,
  wallets: ['alice', 'bob', 'carol'],
  mints: ['mint-a', 'mint-b'],
  commands: 24,
  initialFunding: 128,
  maxAmount: 32,
  checkpointEvery: 8,
});

/** Outcome fields compared as one object so a mismatch also prints the reason and findings. */
function outcomeOf(run: ScenarioRun) {
  return {
    outcome: run.outcome,
    expectationMet: run.expectationMet,
    reason: run.reason,
    findings: run.verdict?.findings.map((finding) => `${finding.code}: ${finding.message}`),
    checkpoints: run.checkpoints.map((checkpoint) => checkpoint.status),
    tracePath: run.tracePath,
  };
}

function expectSecretFreeTrace(run: ScenarioRun) {
  const trace = readFileSync(run.tracePath, 'utf8');
  expect(run.secretsChecked).toBeGreaterThan(0);
  for (const marker of ['cashuA', 'cashuB', '"secret"', 'seed":"']) {
    expect(trace).not.toContain(marker);
  }
}

const count = (run: ScenarioRun, kind: string, result: string) =>
  run.commands.filter((command) => command.kind === kind && command.result === result).length;

describe('wallet fault simulation against a real mint', () => {
  it(
    'does not expire a completed Send while later foreground work delays the checkpoint',
    async () => {
      const run = await runScenario({
        ...scenarios.healthyTransfer,
        id: 'completed-before-heal-delayed-checkpoint',
        recoveryDeadlineMs: 0,
        steps: [
          { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'token-1' },
          { kind: 'heal' },
          { kind: 'restart', wallet: 'bob' },
          { kind: 'fund', wallet: 'bob', mint: 'mint-a', amount: 64 },
          { kind: 'checkpoint' },
        ],
      });
      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.verdict?.ledger.outstanding).toBe(32);
    },
    scenarioTimeoutMs,
  );

  it(
    'remembers recovery within the window when foreground races delay the checkpoint',
    async () => {
      const run = await runScenario({
        ...scenarios.lostReceiveResponseCrash,
        id: 'recovered-before-deadline-delayed-checkpoint',
        recoveryDeadlineMs: 5_000,
        steps: [
          ...scenarios.lostReceiveResponseCrash.steps.slice(0, -1).flatMap<ScenarioStep>((step) =>
            // Settle the sender before starting this Receive recovery window. The earlier
            // slice has no WebSockets and would otherwise need two polling intervals.
            step.kind === 'heal' ? [{ kind: 'restart', wallet: 'alice' }, step] : [step],
          ),
          { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 128 },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'later-1' },
          { kind: 'raceReclaim', token: 'later-1', recipient: 'bob', lead: 'recipient' },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 21, token: 'later-2' },
          { kind: 'raceReclaim', token: 'later-2', recipient: 'bob', lead: 'recipient' },
          { kind: 'checkpoint' },
        ],
      });
      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.checkpoints[0]!.msAwaitingOutcomes).toBeGreaterThan(5_000);
      expect(run.crashes).toHaveLength(1);
    },
    scenarioTimeoutMs,
  );

  it(
    'retains an expired recovery deadline even when final accounting sees finalized Receive',
    async () => {
      const run = await runScenario({
        ...scenarios.lostReceiveResponseCrash,
        id: 'negative-control-expired-recovery-deadline',
        expect: 'detected-failure',
        recoveryDeadlineMs: 0,
      });
      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
      expect(run.verdict?.ledger.holdings.bob).toBe(31);
      expect(run.verdict?.findings).toContainEqual(
        expect.objectContaining({
          code: 'outcome_unmet',
          message: 'receive missed the recovery deadline',
        }),
      );
    },
    scenarioTimeoutMs,
  );

  it(
    'healthy baseline: a funded Send and Receive pass independent accounting',
    async () => {
      const run = await runScenario(scenarios.healthyTransfer);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(run.verdict?.ledger).toMatchObject({ funded: 64, outstanding: 0, unexplained: 0 });
      expect(run.verdict?.ledger.fees).toBeGreaterThan(0);
      expect(run.verdict?.ledger.holdings.bob).toBeGreaterThan(0);
      expect(run.faultsFired).toEqual([]);
      expectSecretFreeTrace(run);
    },
    scenarioTimeoutMs,
  );

  it(
    'lost successful Receive response, SIGKILL and restart: Coco recovers automatically',
    async () => {
      const run = await runScenario(scenarios.lostReceiveResponseCrash);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
      // The fault fired on the Receive swap after the mint answered, and the mint accepted it.
      expect(run.faultsFired).toEqual([
        expect.objectContaining({ method: 'POST', path: '/v1/swap', applied: 1 }),
      ]);
      expect(run.crashes).toEqual([
        expect.objectContaining({
          wallet: 'bob',
          signal: 'SIGKILL',
          mintAcceptedRequest: true,
          persistedOperationState: 'executing',
        }),
      ]);
      expect(run.verdict?.ledger).toMatchObject({ funded: 64, outstanding: 0, unexplained: 0 });
      expect(run.verdict?.ledger.holdings.bob).toBeGreaterThan(0);
      expectSecretFreeTrace(run);

      // Scenario-level replay from clean state, driven only by the recorded trace.
      const replay = await replayScenario(run.tracePath);
      expect(outcomeOf(replay)).toMatchObject({ outcome: 'pass', expectationMet: true });
      expect(replay.runId).not.toBe(run.runId);
      expect(replay.faultsFired).toEqual([
        expect.objectContaining({ method: 'POST', path: '/v1/swap', applied: 1 }),
      ]);
      expect(replay.crashes).toEqual([
        expect.objectContaining({
          mintAcceptedRequest: true,
          persistedOperationState: 'executing',
        }),
      ]);
    },
    scenarioTimeoutMs * 2,
  );

  it(
    'negative control: an unrecovered lost Receive is detected as missing value',
    async () => {
      const run = await runScenario(scenarios.lostReceiveResponseWithoutRestart);

      // A detected wallet failure is this control's expected result, not a passing scenario.
      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
      expect(run.crashes).toEqual([expect.objectContaining({ mintAcceptedRequest: true })]);
      const codes = run.verdict?.findings.map((finding) => finding.code);
      expect(codes).toContain('value_deficit');
      expect(codes).toContain('outcome_unmet');
      expectSecretFreeTrace(run);
    },
    scenarioTimeoutMs,
  );
});

describe('three Wallets at two real mints', () => {
  it(
    'healthy workload: transfers, duplicate deliveries, reclaims and races stay accounted for',
    async () => {
      const run = await runScenario(scenarios.healthyWorkload);

      expect(outcomeOf(run)).toMatchObject({
        outcome: 'pass',
        expectationMet: true,
        checkpoints: ['pass', 'pass'],
      });
      // Both supported race outcomes, each with the follower overlapping the held lead, plus an
      // unled race whose winner the mint decided.
      expect(run.races).toEqual([
        expect.objectContaining({
          token: 'a2',
          lead: 'recipient',
          winner: 'recipient',
          overlapped: true,
        }),
        expect.objectContaining({
          token: 'b2',
          lead: 'sender',
          winner: 'sender',
          overlapped: true,
        }),
        expect.objectContaining({
          token: 'c3',
          winner: expect.stringMatching(/^(recipient|sender)$/),
        }),
      ]);
      // Duplicate deliveries to the recipient and to other Wallets, and claims of reclaimed or
      // raced tokens, are all rejected without credit.
      expect(count(run, 'receive', 'rejected')).toBe(4);
      expect(count(run, 'receive', 'completed')).toBe(2);
      expect(count(run, 'reclaim', 'completed')).toBe(1);
      expect(count(run, 'reclaim', 'rejected')).toBe(1);
      expect(count(run, 'restart', 'completed')).toBe(2);
      const ledger = run.verdict!.ledger;
      expect(ledger).toMatchObject({ funded: 768, unexplained: 0, stranded: 0 });
      // The intentionally undelivered token remains separately accounted for at its mint.
      expect(ledger.mints['mint-b']).toMatchObject({ funded: 384, outstanding: 7, unexplained: 0 });
      expect(ledger.mints['mint-a']).toMatchObject({ funded: 384, outstanding: 0, unexplained: 0 });
      expect(ledger.mints['mint-a']!.fees).toBeGreaterThan(0);
      expect(ledger.mints['mint-b']!.fees).toBeGreaterThan(0);
      expect(run.faultsFired).toEqual([]);
      expectSecretFreeTrace(run);
    },
    workloadTimeoutMs,
  );

  it(
    'negative control: value missing from real evidence is detected',
    async () => {
      const run = await runScenario(scenarios.hiddenHeldProofControl);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
      const codes = run.verdict?.findings.map((finding) => finding.code);
      expect(codes).toContain('value_deficit');
      expect(codes).toContain('wallet_value_mismatch');
    },
    scenarioTimeoutMs,
  );

  it(
    'negative control: value duplicated in real evidence is detected',
    async () => {
      const run = await runScenario(scenarios.duplicatedHeldProofControl);

      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
      const codes = run.verdict?.findings.map((finding) => finding.code);
      expect(codes).toContain('duplicate_claim');
      expect(codes).toContain('wallet_value_mismatch');
    },
    scenarioTimeoutMs,
  );

  for (const [index, seed] of seeds.entries()) {
    it(
      `generated workload from scenario seed ${seed} stays accounted for`,
      async () => {
        const plan = generateWorkload(generatedWorkload(seed));
        const run = await runScenario(plan);

        expect(outcomeOf(run)).toMatchObject({ outcome: 'pass', expectationMet: true });
        expect(run.checkpoints.length).toBeGreaterThanOrEqual(3);
        expect(run.checkpoints.every((checkpoint) => checkpoint.status === 'pass')).toBe(true);
        expect(run.verdict!.ledger.outstanding).toBeGreaterThan(0);
        expectSecretFreeTrace(run);

        if (index === 0) {
          // Replay regenerates the same commands from the recorded seed; scheduling may differ.
          const replay = await replayScenario(run.tracePath);
          expect(outcomeOf(replay)).toMatchObject({ outcome: 'pass', expectationMet: true });
          const byStep = (commands: ScenarioRun['commands']) =>
            commands.map(({ step, kind }) => ({ step, kind })).sort((a, b) => a.step - b.step);
          expect(byStep(replay.commands)).toEqual(byStep(run.commands));
        }
      },
      workloadTimeoutMs * 2,
    );
  }
});
