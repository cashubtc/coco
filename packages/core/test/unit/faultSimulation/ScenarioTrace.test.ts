import { describe, expect, it } from 'bun:test';
import { scenarios } from '../../fault-simulation/scenarios.ts';
import { RedactionError, ScenarioTrace, TRACE_FORMAT } from '../../fault-simulation/trace.ts';

describe('ScenarioTrace', () => {
  it('serializes the replayable plan and ordered events with secrets as references only', () => {
    const trace = new ScenarioTrace('run-1', scenarios.lostReceiveResponseCrash);
    trace.registerSecret('cashuBsecret-token', 'f'.repeat(128));
    trace.record('alice', 'result', { type: 'send', token: 'token-1' });
    trace.record('gateway', 'fault_fired', { ruleId: 'http-rule-1' });

    const document = JSON.parse(trace.serialize());

    expect(document).toMatchObject({
      format: TRACE_FORMAT,
      runId: 'run-1',
      plan: scenarios.lostReceiveResponseCrash,
    });
    expect(document.events.map((event: { seq: number; type: string }) => event.seq)).toEqual([
      1, 2,
    ]);
    expect(document.events[0].data).toEqual({ type: 'send', token: 'token-1' });
  });

  it('refuses to serialize when a registered secret would reach the trace', () => {
    const trace = new ScenarioTrace('run-1', scenarios.healthyTransfer);
    const walletSeed = 'a1'.repeat(64);
    trace.registerSecret(walletSeed);
    trace.record('harness', 'error', { message: `failed with ${walletSeed}` });

    expect(() => trace.serialize()).toThrow(RedactionError);
  });
});
