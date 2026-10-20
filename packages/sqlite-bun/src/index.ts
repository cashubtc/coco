import type { Database } from 'bun:sqlite';
import type { CocoStorage } from '@cashu/coco-core';
import { assertStorageVersion, createStorageHandle } from '@cashu/coco-core/internal';
import { storageIntegrationVersion as sqlVersion } from '@cashu/coco-sql-storage/internal';
import { version } from '../package.json';
import { SqliteRepositories } from './internal.ts';

export interface SqliteStorageOptions {
  database: Database;
  mintSwap?: boolean;
}
/** Borrow a caller-opened SQLite connection. The caller remains responsible for closing it. */
export function createSqliteStorage(options: SqliteStorageOptions): CocoStorage {
  assertStorageVersion(version);
  assertStorageVersion(sqlVersion);
  return createStorageHandle(() => new SqliteRepositories(options), version);
}
