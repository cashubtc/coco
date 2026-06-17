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
