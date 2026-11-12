/**
 * Real-mint coverage of failure evidence, clean-state replay and minimization.
 *
 * Like `walletFaultSimulation.sim.ts`, this starts pinned mint containers, Fault Lab gateways and
 * Wallet processes, and is outside the default `*.test.ts` glob. Run it from the repository root:
 *
 *   bun run --filter='@cashu/coco-core' build && \
 *     bun test ./packages/core/test/fault-simulation/walletFaultSimulationArtifacts.sim.ts
 */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportPortableArtifacts, inspectPrivateRetention } from './artifacts.ts';
import { minimizeTrace } from './minimize.ts';
import { replayTrace } from './replay.ts';
import { buildRunReport, failureSignature } from './report.ts';
import { runScenario } from './runner.ts';
import type { ScenarioPlan } from './scenarios.ts';
import { readTraceFile } from './trace.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/** Every file under a directory with its content, to show evidence is left untouched. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files[path] = readFileSync(path, 'base64');
  }
  return files;
}

function expectPortable(tracePath: string) {
  const outDir = mkdtempSync(join(tmpdir(), 'coco-faultsim-portable-'));
  try {
    const exported = exportPortableArtifacts(dirname(tracePath), outDir);
    expect(exported.withheld).toEqual([]);
    expect(exported.files).toEqual(expect.arrayContaining(['trace.json', 'report.json']));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

/**
 * A known-bad outcome treated as a failing generated run: the lost-response crash of S1 is never
 * followed by a restart, so Bob's accepted Receive is never recovered, while unrelated transfers
 * at the other mint happen around it. Expecting `pass` makes the detected loss a failure.
 */
const knownBadWithNoise: ScenarioPlan = {
  id: 'known-bad-unrecovered-receive-with-noise',
  description:
    'Known-bad outcome for evidence and minimization: an accepted Receive whose response is ' +
    'withheld and whose Wallet is SIGKILLed and never restarted, among unrelated transfers.',
  expect: 'pass',
  recoveryMode: 'automatic',
  recoveryDeadlineMs: 15_000,
  wallets: ['alice', 'bob', 'carol'],
  mints: ['mint-a', 'mint-b'],
  steps: [
    { kind: 'fund', wallet: 'carol', mint: 'mint-b', amount: 64 },
    { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
    { kind: 'send', wallet: 'carol', mint: 'mint-b', amount: 16, token: 'c1' },
    { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'a1' },
    { kind: 'receive', wallet: 'alice', token: 'c1' },
    { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
    { kind: 'receive', wallet: 'bob', token: 'a1', crashWhenFaultFires: true },
    { kind: 'heal' },
    { kind: 'checkpoint' },
  ],
};

describe('wallet fault simulation evidence against real mints', () => {
  it('replays the recorded S1 v1 funded controlled interruption from clean state', async () => {
    const tracePath = fixture('v1-receive-lost-response-crash-restart.trace.json');
    const before = readFileSync(tracePath, 'utf8');

    const result = await replayTrace(tracePath);

    expect(result.provenance).toMatchObject({
      originalFormat: 'coco-wallet-fault-simulation/trace/v1',
    });
    expect(result.comparison).toMatchObject({
      status: 'consistent',
      original: 'expectation_met',
      replayOutcome: 'pass',
    });
    const replay = buildRunReport(readTraceFile(result.tracePath));
    // The withheld response, the crash and the restart actually happened again.
    expect(replay.coverage.faults).toEqual({
      fired: { 'POST /v1/swap after_downstream_response/delay @mint-a': 1 },
      unfired: {},
    });
    expect(replay.coverage.crashes).toEqual({
      'SIGKILL mintAcceptedRequest=true persisted=executing': 1,
    });
    expect(replay.coverage.restarts).toEqual({ after_crash: 1 });
    expect(replay.accounting.unexplained).toEqual({ 'mint-a': 0 });
    expect(replay.scenario.replayOf).toBe(readTraceFile(tracePath).runId);
    expectPortable(result.tracePath);
    expect(readFileSync(tracePath, 'utf8')).toBe(before);
  }, 240_000);

  it('a passing replay of a recorded generated failure leaves the original unresolved', async () => {
    // Seed 2 failed with a false 1-sat deficit from a checker defect that S2 fixed.
    const tracePath = fixture('v2-generated-seed-2-false-deficit.trace.json');
    const before = readFileSync(tracePath, 'utf8');

    const result = await replayTrace(tracePath);

    expect(result.provenance.generator).toEqual({
      seed: 2,
      version: 1,
      currentGenerator: 'reproduces',
    });
    expect(result.comparison).toMatchObject({
      status: 'not_reproduced',
      original: 'unresolved',
      replayOutcome: 'pass',
    });
    const replayed = readTraceFile(result.tracePath);
    expect(replayed.plan.steps).toEqual(readTraceFile(tracePath).plan.steps);
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8')).comparison.status).toBe(
      'not_reproduced',
    );
    expect(readFileSync(tracePath, 'utf8')).toBe(before);
  }, 300_000);

  it('retains a known-bad failure through replay and minimization, and shrinks it to its cause', async () => {
    const original = await runScenario(knownBadWithNoise);
    expect(original).toMatchObject({ outcome: 'wallet_failure', expectationMet: false });
    const runDir = dirname(original.tracePath);
    // Failure evidence was preserved before teardown: trace and protected private inputs.
    expect(inspectPrivateRetention(runDir)).toMatchObject({ retained: true, protected: true });
    const signature = failureSignature(readTraceFile(original.tracePath));
    expect(signature.findings).toEqual(
      expect.arrayContaining(['outcome_unmet wallet=bob', 'value_deficit mint=mint-a']),
    );
    expectPortable(original.tracePath);
    const evidence = snapshot(runDir);

    const replay = await replayTrace(original.tracePath);
    expect(replay.comparison).toMatchObject({ status: 'reproduced', original: 'unresolved' });

    const outDir = mkdtempSync(join(tmpdir(), 'coco-faultsim-minimization-'));
    try {
      const minimized = await minimizeTrace(original.tracePath, { maxRuns: 14, outDir });
      expect(minimized.original).toEqual({
        runId: readTraceFile(original.tracePath).runId,
        signature,
      });
      expect(['minimized', 'budget_exhausted']).toContain(minimized.status);
      // Only commands unrelated to the failure were removed; its preconditions remain.
      expect(minimized.plan.steps).toEqual(
        expect.arrayContaining([
          { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
          { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'a1' },
          { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
          { kind: 'receive', wallet: 'bob', token: 'a1', crashWhenFaultFires: true },
          { kind: 'heal' },
        ]),
      );
      expect(minimized.plan.steps.length).toBeLessThan(knownBadWithNoise.steps.length);
      if (minimized.status === 'minimized') {
        expect(minimized.plan.steps).toHaveLength(6);
      }
      const accepted = minimized.attempts.filter((attempt) => attempt.result === 'reproduced');
      expect(accepted.at(-1)?.keptSteps).toEqual(minimized.keptSteps);
      expect(JSON.parse(readFileSync(join(outDir, 'minimized-plan.json'), 'utf8'))).toEqual(
        minimized.plan,
      );
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
    // Neither the replay nor any minimization run touched the original evidence.
    expect(snapshot(runDir)).toEqual(evidence);
  }, 900_000);
});
