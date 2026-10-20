/** INTERNAL: no compatibility or versioning guarantees, including patch/minor releases. */
import type { SQLiteDatabase } from 'expo-sqlite';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage/internal';
import { ExpoSqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: SQLiteDatabase;
  mintSwap?: boolean;
}

export class SqliteRepositories extends SqlStorageRepositories {
  private readonly driver: ExpoSqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    const database = new ExpoSqliteDb(options);
    super({
      database,
      mintSwap: options.mintSwap,
    });
    this.driver = database;
  }

  override async init(): Promise<void> {
    await this.driver.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    await super.init();
  }
}

export type ExpoSqliteRepositoriesOptions = SqliteRepositoriesOptions;
export { SqliteRepositories as ExpoSqliteRepositories };
