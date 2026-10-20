/** INTERNAL: no compatibility or versioning guarantees, including patch/minor releases. */
import type { Database } from 'better-sqlite3';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage/internal';
import { SqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: Database;
  mintSwap?: boolean;
}

export class SqliteRepositories extends SqlStorageRepositories {
  private readonly driver: SqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    const database = new SqliteDb(options);
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
