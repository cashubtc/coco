/**
 * Replays a recorded scenario trace from clean state.
 *
 * Usage: bun packages/core/test/fault-simulation/replay.ts <trace.json>
 *
 * Exits nonzero unless the replay meets the plan's expectation. The original trace is never
 * modified; a replay that does not reproduce leaves the original failure unresolved.
 */
import { replayScenario } from './runner.ts';

const tracePath = process.argv[2];
if (!tracePath) {
  console.error('Usage: bun packages/core/test/fault-simulation/replay.ts <trace.json>');
  process.exit(2);
}
const run = await replayScenario(tracePath);
console.log(
  JSON.stringify(
    {
      runId: run.runId,
      outcome: run.outcome,
      expectationMet: run.expectationMet,
      reason: run.reason,
      faultsFired: run.faultsFired,
      crashes: run.crashes,
      findings: run.verdict?.findings,
      tracePath: run.tracePath,
    },
    null,
    2,
  ),
);
process.exit(run.expectationMet ? 0 : 1);
