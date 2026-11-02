import { afterEach, describe, expect, it } from 'bun:test';

import { initializeCoco, type CocoConfig, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
const originalFetch = globalThis.fetch;
const sessions: Manager[] = [];

// A 2-request burst, then one request per 100ms.
const capacity = 2;
const refillIntervalMs = 100;

async function addMintAndRecordRequestTimes(requestRateLimit: CocoConfig['requestRateLimit']) {
  const times: number[] = [];
  globalThis.fetch = ((input, init) => {
    if (String(input).startsWith(mintUrl)) times.push(performance.now());
    return originalFetch(input, init);
  }) as typeof fetch;

  const repo = new MemoryRepositories();
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => crypto.getRandomValues(new Uint8Array(64)),
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
    },
    requestRateLimit,
  });
  sessions.push(coco);

  await coco.mint.addMint(mintUrl, { trusted: true });
  return times;
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const coco of sessions.splice(0)) await coco.dispose();
});

describe('requestRateLimit', () => {
  it('queues mint requests beyond the configured burst', async () => {
    const times = await addMintAndRecordRequestTimes({
      capacity,
      refillPerMinute: 60_000 / refillIntervalMs,
    });

    expect(times.length).toBeGreaterThan(capacity);
    const queued = times.length - capacity;
    // Allow a 20% margin for timer jitter.
    expect(times.at(-1)! - times[0]!).toBeGreaterThanOrEqual(queued * refillIntervalMs * 0.8);
  });

  it('sends requests without queueing when disabled', async () => {
    // With one token refilled per minute, any queued request would outlast the test timeout, so
    // this does not depend on how fast the mint responds.
    const times = await addMintAndRecordRequestTimes({
      capacity: 1,
      refillPerMinute: 1,
      disabled: true,
    });

    expect(times.length).toBeGreaterThan(1);
  }, 10_000);
});
