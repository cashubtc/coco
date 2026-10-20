import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Manager } from '@cashu/coco-core';
import { createSqliteStorage, SqlTransactionConflictError, type SqlDatabase } from '../index.ts';
import { createBunSqlDatabase } from './bunSqlDatabase.ts';

describe('independent SQLite driver transactions', () => {
  it('leaves initialization and plugin startup under manual control', async () => {
    const raw = new Database(':memory:');
    const driver = createBunSqlDatabase(raw);
    let scripts = 0;
    let plugins = 0;
    const execute = driver.exec.bind(driver);
    driver.exec = async (sql) => {
      scripts++;
      await execute(sql);
    };
    const storage = createSqliteStorage({ database: driver });
    const manager = new Manager(storage, async () => new Uint8Array(64), undefined, undefined, [
      {
        name: 'manual',
        required: [],
        onInit() {
          plugins++;
        },
      },
    ]);
    try {
      await Promise.resolve();
      expect(scripts).toBe(0);
      expect(plugins).toBe(0);
      await storage.init();
      await manager.initPlugins();
      expect(plugins).toBe(1);
      expect(await manager.wallet.balances.byUnit()).toEqual({});
    } finally {
      await manager.dispose();
      raw.close();
    }
  });

  it('retries a rolled back conflict without committing two Keypair Allocations', async () => {
    const raw = new Database(':memory:');
    const base = createBunSqlDatabase(raw);
    let injectConflict = false;
    let attempts = 0;
    const driver: SqlDatabase = {
      exec: (sql) => base.exec(sql),
      run: (sql, params) => base.run(sql, params),
      get: (sql, params) => base.get(sql, params),
      all: (sql, params) => base.all(sql, params),
      transaction: (work, options) =>
        base.transaction(async (tx) => {
          const result = await work(tx);
          if (injectConflict) {
            attempts++;
            if (attempts === 1) throw new SqlTransactionConflictError();
          }
          return result;
        }, options),
    };
    const storage = createSqliteStorage({ database: driver });
    await storage.init();
    const manager = new Manager(storage, async () => new Uint8Array(64).fill(7));
    try {
      injectConflict = true;
      const first = await manager.keyring.generateKeyPair(true);
      expect(attempts).toBe(2);
      expect(first.derivationIndex).toBe(0);
      expect(await manager.keyring.getAllKeyPairs()).toHaveLength(1);
      expect((await manager.keyring.generateKeyPair(true)).derivationIndex).toBe(1);
    } finally {
      await manager.dispose();
      raw.close();
    }
  });

  it('does not retry an unclassified commit failure even if it resembles a lock error', async () => {
    const raw = new Database(':memory:');
    const base = createBunSqlDatabase(raw);
    let failCommit = false;
    let attempts = 0;
    const failure = Object.assign(new Error('database is locked; outcome unknown'), {
      code: 'SQLITE_BUSY',
    });
    const driver: SqlDatabase = {
      exec: (sql) => base.exec(sql),
      run: (sql, params) => base.run(sql, params),
      get: (sql, params) => base.get(sql, params),
      all: (sql, params) => base.all(sql, params),
      async transaction(work, options) {
        const result = await base.transaction(work, options);
        if (failCommit) {
          attempts++;
          throw failure;
        }
        return result;
      },
    };
    const storage = createSqliteStorage({ database: driver });
    await storage.init();
    const manager = new Manager(storage, async () => new Uint8Array(64).fill(7));
    try {
      failCommit = true;
      await expect(manager.keyring.generateKeyPair(true)).rejects.toBe(failure);
      expect(attempts).toBe(1);
      expect(await manager.keyring.getAllKeyPairs()).toHaveLength(1);
    } finally {
      await manager.dispose();
      raw.close();
    }
  });
});
