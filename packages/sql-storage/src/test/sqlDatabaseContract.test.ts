import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runSqlDatabaseContract } from './index.ts';
import { createBunSqlDatabase } from './bunSqlDatabase.ts';

runSqlDatabaseContract(
  {
    createDatabase() {
      const rawDatabase = new Database(':memory:');
      const database = createBunSqlDatabase(rawDatabase);

      return {
        database,
        dispose() {
          rawDatabase.close();
        },
      };
    },
  },
  { describe, expect, it },
);
