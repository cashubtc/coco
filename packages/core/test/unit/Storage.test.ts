import { describe, expect, it } from 'bun:test';
import { createMemoryStorage, initializeCoco, Manager } from '../../index.ts';

const seedGetter = async () => new Uint8Array(32);
const background = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
};

describe('opaque storage startup', () => {
  it('initializes storage automatically and supports another session with the same handle', async () => {
    const storage = createMemoryStorage();
    const coco = await initializeCoco({ storage, seedGetter, ...background });
    expect(await coco.wallet.balances.byUnit()).toEqual({});
    await coco.dispose();
    const next = await initializeCoco({ storage, seedGetter, ...background });
    expect(await next.wallet.balances.byUnit()).toEqual({});
    await next.dispose();
  });

  it('supports explicit initialization and manual construction', async () => {
    const storage = createMemoryStorage();
    await storage.init();
    const coco = new Manager(storage, seedGetter);
    expect(await coco.wallet.balances.byUnit()).toEqual({});
    await coco.dispose();
  });
});
