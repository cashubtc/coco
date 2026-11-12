/**
 * Best-effort minimization of a recorded failing scenario.
 *
 * Usage: bun packages/core/test/fault-simulation/minimize.ts <trace.json> [maxRuns]
 *
 * Removes contiguous groups of steps, halving the group size when nothing can be removed (delta
 * debugging restricted to removals), and keeps a candidate only when a fresh clean-state run of it
 * fails with the same {@link FailureSignature}. A candidate that violates a state or fault
 * precondition is never run. A candidate that passes, fails differently or cannot run is
 * rejected; none of them changes the original's status. The original trace and private inputs
 * are never written; results go to a new directory. A run budget bounds the search, so a result
 * is 1-minimal only when the status is `minimized` or `not_minimized`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failureSignature, sameFailure, type FailureSignature } from './report.ts';
import type { ScenarioPlan } from './scenarios.ts';
import { readTraceFile } from './trace.ts';
import { MINT_INPUT_FEE_PPK } from './environment.ts';
import { WorkloadModel } from './workload.ts';

/** What one candidate run showed: its failure identity and where its evidence is kept. */
export interface CandidateObservation {
  signature: FailureSignature;
  evidence?: string;
}

export type CandidateRunner = (plan: ScenarioPlan) => Promise<CandidateObservation>;

export interface MinimizationAttempt {
  /** Indices into the original plan's steps. */
  keptSteps: number[];
  result: 'reproduced' | 'not_reproduced' | 'different_failure' | 'error';
  signature?: FailureSignature;
  evidence?: string;
  error?: string;
}

export interface MinimizationResult {
  /**
   * `minimized`: steps were removed and no single group removal of the result reproduces.
   * `not_minimized`: the failure reproduced but no step could be removed.
   * `budget_exhausted`: the run budget ended the search; the plan is the smallest observed to
   * reproduce. `unreproduced`: the original plan did not reproduce; the original stays unresolved.
   */
  status: 'minimized' | 'not_minimized' | 'budget_exhausted' | 'unreproduced';
  original: { runId: string; signature: FailureSignature };
  /** The original's generator provenance, since the minimized plan is no longer generated. */
  derivedFrom: { runId: string; generator?: ScenarioPlan['generator'] };
  plan: ScenarioPlan;
  keptSteps: number[];
  attempts: MinimizationAttempt[];
  /** Candidates rejected without a run because a precondition would not hold. */
  invalidCandidates: number;
  runs: number;
}

export interface MinimizationOptions {
  maxRuns: number;
}

/** Steps the workload model treats as commands, healing or observation; any other is a fault. */
const NON_FAULT_KINDS = new Set<string>([
  'fund',
  'send',
  'receive',
  'reclaim',
  'raceReclaim',
  'restart',
  // Explicit recovery is a caller command; a crash is ended by `restart`, and a mint restart by
  // the step itself, not by `heal`.
  'recover',
  'crash',
  'restartMint',
  'heal',
  'checkpoint',
]);

/**
 * Why a candidate plan would not exercise the same scenario, or `undefined` if it would. Beyond
 * the workload model's state preconditions, a crash triggered by a fault needs an installed fault
 * since the last healing, and faults must be followed by healing so the run ends healthy.
 */
export function candidatePreconditionViolation(plan: ScenarioPlan): string | undefined {
  const model = new WorkloadModel(plan.wallets, plan.mints, MINT_INPUT_FEE_PPK, plan.recoveryMode);
  let faultInstalled = false;
  for (const [index, step] of plan.steps.entries()) {
    try {
      if (!model.apply(step, index)) return `step ${index} kind ${step.kind} is not supported`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    if (step.kind === 'heal') faultInstalled = false;
    else if (!NON_FAULT_KINDS.has(step.kind)) faultInstalled = true;
    else if (
      (step.kind === 'receive' || step.kind === 'send') &&
      step.crashWhenFaultFires &&
      !faultInstalled
    ) {
      return `step ${index} crashes on a fault that is not installed`;
    }
  }
  if (faultInstalled) return 'a fault is still installed when the plan ends';
  try {
    model.finish();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export async function minimizeFailure(
  original: { plan: ScenarioPlan; signature: FailureSignature; runId: string },
  run: CandidateRunner,
  options: MinimizationOptions,
): Promise<MinimizationResult> {
  const source = structuredClone(original.plan);
  const { generator, ...withoutGenerator } = source;
  const derivedPlan = (kept: number[]): ScenarioPlan => ({
    ...structuredClone(withoutGenerator),
    id: `${source.id}-minimized`,
    steps: kept.map((index) => structuredClone(source.steps[index]!)),
  });

  const attempts: MinimizationAttempt[] = [];
  let runs = 0;
  let invalidCandidates = 0;
  const attempt = async (kept: number[], plan: ScenarioPlan): Promise<boolean> => {
    runs++;
    let observation: CandidateObservation;
    try {
      observation = await run(plan);
    } catch (error) {
      attempts.push({
        keptSteps: kept,
        result: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    const reproduced = sameFailure(observation.signature, original.signature);
    attempts.push({
      keptSteps: kept,
      result: reproduced
        ? 'reproduced'
        : observation.signature.outcome === 'pass'
          ? 'not_reproduced'
          : 'different_failure',
      signature: observation.signature,
      ...(observation.evidence ? { evidence: observation.evidence } : {}),
    });
    return reproduced;
  };

  const all = source.steps.map((_, index) => index);
  const result = (status: MinimizationResult['status'], kept: number[]): MinimizationResult => ({
    status,
    original: { runId: original.runId, signature: original.signature },
    derivedFrom: { runId: original.runId, ...(generator ? { generator } : {}) },
    plan: status === 'unreproduced' ? source : derivedPlan(kept),
    keptSteps: kept,
    attempts,
    invalidCandidates,
    runs,
  });

  // The baseline confirms the failure reproduces from clean state before anything is removed.
  if (!(await attempt(all, source))) return result('unreproduced', all);

  // The final step is where the failure was detected (a checkpoint); it is never removed.
  let kept = all;
  let groups = 2;
  while (true) {
    const removable = kept.slice(0, -1);
    if (removable.length === 0) break;
    groups = Math.min(groups, removable.length);
    const size = Math.ceil(removable.length / groups);
    let reduced = false;
    for (let start = 0; start < removable.length; start += size) {
      const removed = new Set(removable.slice(start, start + size));
      const candidate = kept.filter((index) => !removed.has(index));
      const plan = derivedPlan(candidate);
      if (candidatePreconditionViolation(plan)) {
        invalidCandidates++;
        continue;
      }
      if (runs >= options.maxRuns) return result('budget_exhausted', kept);
      if (await attempt(candidate, plan)) {
        kept = candidate;
        groups = Math.max(groups - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (groups >= removable.length) break;
      groups = Math.min(groups * 2, removable.length);
    }
  }
  return result(kept.length < all.length ? 'minimized' : 'not_minimized', kept);
}

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * Minimizes the failure recorded in a trace with real clean-state runs. Writes
 * `minimization.json` (result, every attempt and its evidence path) and `minimized-plan.json` to a
 * new directory; the original run directory is not touched.
 */
export async function minimizeTrace(
  tracePath: string,
  options: MinimizationOptions & { outDir?: string },
): Promise<MinimizationResult & { outDir: string }> {
  const trace = readTraceFile(tracePath);
  if (trace.result?.expectationMet === true) {
    throw new Error(`Run ${trace.runId} met its expectation; there is no failure to minimize`);
  }
  const { runScenario } = await import('./runner.ts');
  const result = await minimizeFailure(
    { plan: trace.plan, signature: failureSignature(trace), runId: trace.runId },
    async (plan) => {
      const run = await runScenario(plan, { replayOf: trace.runId });
      return { signature: failureSignature(readTraceFile(run.tracePath)), evidence: run.tracePath };
    },
    options,
  );
  const outDir =
    options.outDir ??
    join(
      process.env.COCO_FAULT_SIM_ARTIFACTS ?? join(repositoryRoot, '.cache', 'fault-simulation'),
      'minimizations',
      `${trace.runId}-${Date.now()}`,
    );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'minimization.json'),
    JSON.stringify({ originalTracePath: tracePath, ...result }, null, 2),
  );
  writeFileSync(join(outDir, 'minimized-plan.json'), JSON.stringify(result.plan, null, 2));
  return { ...result, outDir };
}

if (import.meta.main) {
  const [tracePath, maxRuns = '24'] = process.argv.slice(2);
  if (!tracePath || !/^[1-9]\d*$/.test(maxRuns)) {
    console.error(
      'Usage: bun packages/core/test/fault-simulation/minimize.ts <trace.json> [maxRuns]',
    );
    process.exit(2);
  }
  const result = await minimizeTrace(tracePath, { maxRuns: Number(maxRuns) });
  const { attempts, ...summary } = result;
  console.log(JSON.stringify({ ...summary, attempts: attempts.length }, null, 2));
  process.exit(result.status === 'unreproduced' ? 1 : 0);
}
