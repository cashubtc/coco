/**
 * Clean-state scenario replay of a recorded trace.
 *
 * Usage: bun packages/core/test/fault-simulation/replay.ts <trace.json>
 *
 * Replay executes the recorded commands and fault plan exactly as recorded, in a fresh world with
 * fresh Wallet Seeds; it never regenerates commands from a scenario seed, so a later generator
 * change cannot silently replace the workload. It reproduces commands and request-triggered
 * faults, not operating-system scheduling. The original run directory is never written: the
 * replay is a new run whose `replay.json` compares it with the original. A replay that passes does
 * not resolve the original failure.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ScenarioPlan } from './scenarios.ts';
import { compareRuns, failureSignature, type ReplayComparison } from './report.ts';
import { UnsupportedTraceError, readTraceFile, type RecordedTrace } from './trace.ts';
import { WorkloadModel, generateWorkload } from './workload.ts';

export interface ReplayProvenance {
  originalRunId: string;
  originalFormat: string;
  /**
   * For a generated plan: the recorded scenario seed and generator version, and whether the
   * current generator still produces the recorded commands. Descriptive only; replay always runs
   * the recorded commands.
   */
  generator?: {
    seed: number;
    version: number;
    currentGenerator: 'reproduces' | 'differs' | 'not_regenerable';
  };
}

export interface PreparedReplay {
  plan: ScenarioPlan;
  provenance: ReplayProvenance;
}

/**
 * Validates that the recorded plan can execute in this harness and returns it unchanged.
 *
 * Throws `PlanPreconditionError` when a recorded step's state precondition no longer holds in the
 * current workload model, and {@link UnsupportedTraceError} for a step kind this harness cannot
 * execute. Neither is replaced by a different plan.
 */
export function prepareReplay(trace: RecordedTrace): PreparedReplay {
  const plan = structuredClone(trace.plan);
  const model = new WorkloadModel(plan.wallets, plan.mints ?? []);
  plan.steps.forEach((step, index) => {
    if (!model.apply(step, index)) {
      throw new UnsupportedTraceError(
        `Step ${index} kind ${String((step as { kind: unknown }).kind)} is not supported by this harness`,
      );
    }
  });
  return {
    plan,
    provenance: {
      originalRunId: trace.runId,
      originalFormat: trace.migratedFrom?.format ?? trace.format,
      ...(plan.generator ? { generator: generatorProvenance(plan) } : {}),
    },
  };
}

function generatorProvenance(plan: ScenarioPlan): NonNullable<ReplayProvenance['generator']> {
  const { version, ...options } = plan.generator!;
  let currentGenerator: 'reproduces' | 'differs' | 'not_regenerable';
  try {
    const regenerated = generateWorkload(options);
    currentGenerator =
      regenerated.generator?.version === version &&
      JSON.stringify(regenerated.steps) === JSON.stringify(plan.steps)
        ? 'reproduces'
        : 'differs';
  } catch {
    currentGenerator = 'not_regenerable';
  }
  return { seed: options.seed, version, currentGenerator };
}

export interface ReplayResult {
  provenance: ReplayProvenance;
  comparison: ReplayComparison;
  /** Trace of the replay run; the original trace path is unchanged. */
  tracePath: string;
  reportPath: string;
}

/** Replays a recorded trace from clean state and records how the replay compares. */
export async function replayTrace(tracePath: string): Promise<ReplayResult> {
  const original = readTraceFile(tracePath);
  const { plan, provenance } = prepareReplay(original);
  // Imported lazily so pure users of this module do not load the real-mint runner.
  const { runScenario } = await import('./runner.ts');
  const run = await runScenario(plan, { replayOf: original.runId });
  const replayed = readTraceFile(run.tracePath);
  const comparison = compareRuns(original, replayed);
  const reportPath = join(dirname(run.tracePath), 'replay.json');
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        originalTracePath: tracePath,
        provenance,
        originalSignature: failureSignature(original),
        replaySignature: failureSignature(replayed),
        comparison,
      },
      null,
      2,
    ),
  );
  return { provenance, comparison, tracePath: run.tracePath, reportPath };
}

if (import.meta.main) {
  const tracePath = process.argv[2];
  if (!tracePath) {
    console.error('Usage: bun packages/core/test/fault-simulation/replay.ts <trace.json>');
    process.exit(2);
  }
  const result = await replayTrace(tracePath);
  console.log(JSON.stringify(result, null, 2));
  // Only a consistent or reproducing replay exits zero; any other result needs investigation.
  process.exit(['consistent', 'reproduced'].includes(result.comparison.status) ? 0 : 1);
}
