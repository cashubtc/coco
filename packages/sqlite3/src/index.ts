import type { Database } from 'better-sqlite3';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage';
import { SqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: Database;
  mintSwap?: boolean;
}

export class SqliteRepositories extends SqlStorageRepositories {
  constructor(options: SqliteRepositoriesOptions) {
    super({
      database: new SqliteDb(options),
      mintSwap: options.mintSwap,
    });
  }
}
