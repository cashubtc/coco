import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  TRACE_FORMAT,
  TRACE_FORMAT_V1,
  UnsupportedTraceError,
  readTrace,
} from '../../fault-simulation/trace.ts';

const fixture = (name: string) =>
  readFileSync(new URL(`../../fault-simulation/fixtures/${name}`, import.meta.url), 'utf8');

const v1CrashRecovery = fixture('v1-receive-lost-response-crash-restart.trace.json');

describe('recorded trace compatibility', () => {
  it('reads an S1 v1 trace as the equivalent current plan without altering its evidence', () => {
    const original = JSON.parse(v1CrashRecovery);

    const trace = readTrace(v1CrashRecovery);

    expect(trace.format).toBe(TRACE_FORMAT);
    expect(trace.migratedFrom?.format).toBe(TRACE_FORMAT_V1);
    expect(trace.runId).toBe(original.runId);
    expect(trace.plan).toEqual({
      id: 'receive-lost-response-crash-restart',
      description: original.plan.description,
      expect: 'pass',
      recoveryMode: 'automatic',
      recoveryDeadlineMs: 60_000,
      wallets: ['alice', 'bob'],
      mints: ['mint-a'],
      steps: [
        { kind: 'fund', wallet: 'alice', mint: 'mint-a', amount: 64 },
        { kind: 'send', wallet: 'alice', mint: 'mint-a', amount: 32, token: 'token-1' },
        { kind: 'withholdResponse', mint: 'mint-a', method: 'POST', path: '/v1/swap' },
        { kind: 'receive', wallet: 'bob', token: 'token-1', crashWhenFaultFires: true },
        { kind: 'heal' },
        { kind: 'restart', wallet: 'bob' },
        { kind: 'checkpoint' },
      ],
    });
    // Observations are historical evidence: kept verbatim, never re-derived.
    expect(trace.events).toEqual(original.events);
    expect(trace.result).toEqual(original.result);
    expect(trace.components).toEqual(original.components);
  });

  it('rejects a v1 requirement the current workload model does not imply', () => {
    const tampered = JSON.parse(v1CrashRecovery);
    tampered.plan.requirements = [
      { wallet: 'alice', operation: 'receive', token: 'token-1', state: 'finalized' },
    ];

    expect(() => readTrace(JSON.stringify(tampered))).toThrow(UnsupportedTraceError);
  });

  it('rejects a v1 step without a current equivalent instead of dropping it', () => {
    const tampered = JSON.parse(v1CrashRecovery);
    tampered.plan.steps.splice(2, 0, { kind: 'dropRequest', path: '/v1/swap' });

    expect(() => readTrace(JSON.stringify(tampered))).toThrow(/dropRequest/);
  });

  it('rejects unknown and newer formats explicitly', () => {
    const newer = {
      ...JSON.parse(v1CrashRecovery),
      format: 'coco-wallet-fault-simulation/trace/v3',
    };

    expect(() => readTrace(JSON.stringify(newer))).toThrow(UnsupportedTraceError);
    expect(() => readTrace('{"format":"something-else"}')).toThrow(UnsupportedTraceError);
    expect(() => readTrace('not json')).toThrow(UnsupportedTraceError);
  });

  it('reads a current v2 trace unchanged, including step kinds this harness does not know', () => {
    const current = JSON.parse(fixture('v2-generated-seed-2-false-deficit.trace.json'));
    current.plan.steps.push({ kind: 'futureFault', mint: 'mint-a' });

    const trace = readTrace(JSON.stringify(current));

    expect(trace.migratedFrom).toBeUndefined();
    expect(trace.plan).toEqual(current.plan);
    expect(trace.events).toEqual(current.events);
  });
});
