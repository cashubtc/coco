import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  runRepositoryTransactionContract,
  runAuthSessionRepositoryContract,
  runProofRepositoryContract,
  runMintOperationRepositoryContract,
  runPaymentRequestReceiveRepositoryContract,
  runReceiveOperationRepositoryContract,
  runSendOperationRepositoryContract,
  runMeltOperationRepositoryContract,
  runMeltQuoteRepositoryContract,
  runMintSwapRepositoryContract,
} from '@cashu/coco-adapter-tests';
import { runSqlDatabaseContract } from '@cashu/coco-sql-storage/test';
import { SqliteRepositories as Repositories } from '../index.ts';
import { SqliteDb } from '../db.ts';

async function createRepositories() {
  const rawDatabase = new Database(':memory:');
  const repositories = new Repositories({ database: rawDatabase });
  await repositories.init();
  return {
    repositories,
    dispose: async () => {
      rawDatabase.close();
    },
  };
}

runSqlDatabaseContract(
  {
    createDatabase() {
      const rawDatabase = new Database(':memory:');
      const database = new SqliteDb({ database: rawDatabase });

      return {
        database,
        dispose: () => database.close(),
      };
    },
  },
  { describe, it, expect },
);

runRepositoryTransactionContract(
  {
    createRepositories,
    testConcurrentRootOperationIsolation: true,
  },
  { describe, it, expect },
);

runAuthSessionRepositoryContract({ createRepositories }, { describe, it, expect });

runProofRepositoryContract({ createRepositories }, { describe, it, expect });

runMintOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runReceiveOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runSendOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltOperationRepositoryContract({ createRepositories }, { describe, it, expect });

runMeltQuoteRepositoryContract({ createRepositories }, { describe, it, expect });

runPaymentRequestReceiveRepositoryContract({ createRepositories }, { describe, it, expect });

runMintSwapRepositoryContract({ createRepositories }, { describe, it, expect });

describe('hydration corruption guard', () => {
  it('throws when send operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_send_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, method, methodDataJson, needsSwap, fee, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'corrupt-send',
          'https://mint.test',
          '100',
          'sat',
          'prepared',
          0,
          0,
          'default',
          '{}',
          0,
          null,
          null,
        ],
      );

      let threw = false;
      try {
        await repositories.sendOperationRepository.getById('corrupt-send');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when receive operation has prepared state but null fee', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_receive_operations
           (id, mintUrl, amount, unit, state, createdAt, updatedAt, fee, inputProofsJson)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['corrupt-receive', 'https://mint.test', '100', 'sat', 'prepared', 0, 0, null, '[]'],
      );

      let threw = false;
      try {
        await repositories.receiveOperationRepository.getById('corrupt-receive');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('throws when melt operation has prepared state but null financial fields', async () => {
    const { repositories, dispose } = await createRepositories();
    try {
      await (repositories as any).db.run(
        `INSERT INTO coco_cashu_melt_operations
           (id, mintUrl, state, createdAt, updatedAt, method, methodDataJson, quoteId, amount, fee_reserve, swap_fee, needsSwap, inputAmount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'corrupt-melt',
          'https://mint.test',
          'prepared',
          0,
          0,
          'bolt11',
          '{"invoice":"lnbc1test"}',
          'q1',
          null,
          null,
          null,
          0,
          null,
        ],
      );

      let threw = false;
      try {
        await repositories.meltOperationRepository.getById('corrupt-melt');
      } catch (e) {
        threw = true;
        expect(String(e)).toContain('missing required field');
      }
      expect(threw).toBe(true);
    } finally {
      await dispose();
    }
  });
});
