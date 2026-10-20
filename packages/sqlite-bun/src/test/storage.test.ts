import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeCoco, Manager } from '@cashu/coco-core';
import { ensureSchemaUpTo } from '@cashu/coco-sql-storage/internal';
import { createSqliteStorage } from '../index.ts';
import { SqliteDb } from '../db.ts';

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
      // A pre-revision schema and raw historical records are independent of current repositories.
      const old = new SqliteDb({ database });
      await ensureSchemaUpTo(old, '039_send_operation_revision');
      await old.run(
        `INSERT INTO coco_cashu_send_operations
        (id, mintUrl, amount, unit, state, createdAt, updatedAt, method, methodDataJson)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['interrupted', 'https://mint.test', '7', 'sat', 'init', 1, 1, 'default', '{}'],
      );
      await old.run(
        `INSERT INTO coco_cashu_proofs
        (mintUrl, id, unit, amount, secret, C, state, createdAt, usedByOperationId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'https://mint.test',
          'keyset',
          'sat',
          '7',
          'legacy-secret',
          '02abcdef',
          'ready',
          1,
          'interrupted',
        ],
      );
      const storage = createSqliteStorage({ database });
      await storage.init();
      const manual = new Manager(storage, seedGetter);
      expect((await manual.ops.send.get('interrupted'))?.state).toBe('init');
      expect((await manual.ops.send.get('interrupted'))?.revision).toBe(0);
      expect((await manual.wallet.balances.total({ trustedOnly: false })).reserved.toNumber()).toBe(
        7,
      );
      const keypair = await manual.keyring.generateKeyPair(true);
      await manual.dispose();
      const coco = await initializeCoco({
        storage: createSqliteStorage({ database }),
        seedGetter,
        ...background,
      });
      expect(await coco.ops.send.get('interrupted')).toBeNull();
      expect((await coco.wallet.balances.total({ trustedOnly: false })).spendable.toNumber()).toBe(
        7,
      );
      expect(await coco.keyring.getKeyPair(keypair.publicKeyHex)).toEqual(keypair);
      await coco.dispose();
      expect(database.prepare('SELECT 1 AS alive').get()).toEqual({ alive: 1 });
      expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    } finally {
      database.close();
    }
  });
});
