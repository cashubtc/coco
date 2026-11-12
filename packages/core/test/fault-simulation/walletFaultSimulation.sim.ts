/**
 * Real-mint wallet fault simulation scenarios.
 *
 * Each scenario starts its own pinned mint container, a pinned Cashu Fault Lab HTTP gateway and
 * Wallet processes with persistent SQLite stores. This file is deliberately outside the default
 * `*.test.ts` glob; run it with `bun run test:fault-simulation` from the repository root.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { replayScenario, runScenario, type ScenarioRun } from './runner.ts';
import { scenarios } from './scenarios.ts';

const scenarioTimeoutMs = 180_000;

/** Outcome fields compared as one object so a mismatch also prints the reason and findings. */
function outcomeOf(run: ScenarioRun) {
  return {
    outcome: run.outcome,
    expectationMet: run.expectationMet,
    reason: run.reason,
    findings: run.verdict?.findings.map((finding) => `${finding.code}: ${finding.message}`),
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

describe('wallet fault simulation against a real mint', () => {
  it(
    'retains an expired recovery deadline even when final accounting sees finalized Receive',
    async () => {
      const run = await runScenario({
        ...scenarios.healthyTransfer,
        id: 'negative-control-expired-recovery-deadline',
        expect: 'detected-failure',
        recoveryDeadlineMs: 0,
      });
      expect(outcomeOf(run)).toMatchObject({ outcome: 'wallet_failure', expectationMet: true });
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
