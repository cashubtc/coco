import type { SQLiteDatabase } from 'expo-sqlite';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage';
import { ExpoSqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: SQLiteDatabase;
}

export class SqliteRepositories extends SqlStorageRepositories {
  constructor(options: SqliteRepositoriesOptions) {
    super({
      database: new ExpoSqliteDb(options),
    });
  }
}

export type ExpoSqliteRepositoriesOptions = SqliteRepositoriesOptions;
export { SqliteRepositories as ExpoSqliteRepositories };
