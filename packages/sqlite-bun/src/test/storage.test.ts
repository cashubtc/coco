import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Amount, initializeCoco, Manager } from '@cashu/coco-core';
import { createSqliteStorage } from '../index.ts';
import { SqliteRepositories } from '../internal.ts';

const seedGetter = async () => new Uint8Array(64).fill(7);
const background = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
};

describe('SQLite opaque storage', () => {
  it('preserves persisted Wallet data, recovers a legacy interrupted send, and leaves the connection caller-owned', async () => {
    const database = new Database(':memory:');
    try {
      // Existing repository formats are a migration fixture; application assertions use public APIs.
      const old = new SqliteRepositories({ database });
      await old.init();
      await old.sendOperationRepository.create({
        id: 'interrupted',
        mintUrl: 'https://mint.test',
        amount: Amount.from(1),
        unit: 'sat',
        method: 'default',
        methodData: {},
        state: 'init',
        createdAt: 1,
        updatedAt: 1,
      });
      const storage = createSqliteStorage({ database });
      await storage.init();
      const manual = new Manager(storage, seedGetter);
      expect((await manual.ops.send.get('interrupted'))?.state).toBe('init');
      const keypair = await manual.keyring.generateKeyPair(true);
      await manual.dispose();
      const coco = await initializeCoco({
        storage: createSqliteStorage({ database }),
        seedGetter,
        ...background,
      });
      expect(await coco.ops.send.get('interrupted')).toBeNull();
      expect(await coco.keyring.getKeyPair(keypair.publicKeyHex)).toEqual(keypair);
      await coco.dispose();
      expect(database.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    } finally {
      database.close();
    }
  });
});
