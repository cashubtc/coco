import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Amount } from '@cashu/cashu-ts';
import { createSqliteStorage, type SqlDatabase, type SqlParams } from '../index.ts';
import { SqlStorageRepositories } from '../repositories.ts';
import { createBunSqlDatabase } from './bunSqlDatabase.ts';

function constrained(database: SqlDatabase, maxParameters: number): SqlDatabase {
  const check = (params?: SqlParams) => {
    if ((params?.length ?? 0) > maxParameters) throw new Error('Too many bound parameters');
  };
  return {
    maxParameters,
    exec: (sql) => database.exec(sql),
    run: (sql, params) => {
      check(params);
      return database.run(sql, params);
    },
    get: (sql, params) => {
      check(params);
      return database.get(sql, params);
    },
    all: (sql, params) => {
      check(params);
      return database.all(sql, params);
    },
    transaction: (work, options) =>
      database.transaction((tx) => work(constrained(tx, maxParameters)), options),
  };
}

describe('SQLite parameter limits', () => {
  it('looks up all proof secrets with a 100-parameter driver, including the mint parameter', async () => {
    const raw = new Database(':memory:');
    try {
      const database = constrained(createBunSqlDatabase(raw), 100);
      const repositories = new SqlStorageRepositories({ database });
      await repositories.init();
      const proofs = Array.from({ length: 205 }, (_, i) => ({
        mintUrl: 'https://mint.test',
        id: 'keyset',
        unit: 'sat',
        amount: Amount.from(1),
        secret: `secret-${i}`,
        C: '02abcdef',
        state: 'ready' as const,
      }));
      await repositories.proofRepository.saveProofs('https://mint.test', proofs);
      const found = await repositories.proofRepository.getProofsBySecrets(
        'https://mint.test',
        proofs.map((p) => p.secret),
      );
      expect(found.map((p) => p.secret)).toEqual(proofs.map((p) => p.secret));
    } finally {
      raw.close();
    }
  });

  it('rejects an unusable declared limit before executing SQL', async () => {
    const raw = new Database(':memory:');
    try {
      const storage = createSqliteStorage({ database: constrained(createBunSqlDatabase(raw), 0) });
      await expect(storage.init()).rejects.toThrow('maxParameters');
    } finally {
      raw.close();
    }
  });

  it('batches combined mint and unit filters without dropping or duplicating proofs', async () => {
    const raw = new Database(':memory:');
    try {
      const repositories = new SqlStorageRepositories({
        database: constrained(createBunSqlDatabase(raw), 100),
      });
      await repositories.init();
      const units = Array.from({ length: 105 }, (_, i) => `unit-${i}`);
      const mints = units.map((_, i) => `https://mint-${i}.test`);
      for (let i = 0; i < units.length; i++) {
        await repositories.proofRepository.saveProofs(mints[i]!, [
          {
            mintUrl: mints[i]!,
            id: 'keyset',
            unit: units[i]!,
            amount: Amount.from(1),
            secret: `secret-${i}`,
            C: '02abcdef',
            state: 'ready',
          },
        ]);
      }
      expect(await repositories.proofRepository.getAllReadyProofs({ units })).toHaveLength(105);
      expect(await repositories.proofRepository.getReadyProofs(mints[0]!, { units })).toHaveLength(
        1,
      );
      expect(
        await repositories.proofRepository.getProofsByKeysetId(mints[0]!, 'keyset', { units }),
      ).toHaveLength(1);
      expect(
        await repositories.proofRepository.getAvailableProofs(mints[0]!, { units }),
      ).toHaveLength(1);
      for (let i = 0; i < units.length; i++) {
        await repositories.proofRepository.setProofState(mints[i]!, [`secret-${i}`], 'inflight');
      }
      const found = await repositories.proofRepository.getInflightProofs(mints, { units });
      expect(found).toHaveLength(105);
      expect(new Set(found.map((proof) => proof.secret)).size).toBe(105);
    } finally {
      raw.close();
    }
  });
});
