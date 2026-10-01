import type { SQLiteDatabase } from 'expo-sqlite';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage';
import { ExpoSqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: SQLiteDatabase;
  mintSwap?: boolean;
}

export class SqliteRepositories extends SqlStorageRepositories {
  constructor(options: SqliteRepositoriesOptions) {
    super({
      database: new ExpoSqliteDb(options),
      mintSwap: options.mintSwap,
    });
  }
}

export type ExpoSqliteRepositoriesOptions = SqliteRepositoriesOptions;
export { SqliteRepositories as ExpoSqliteRepositories };
