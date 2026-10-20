import type { CocoStorage } from '@cashu/coco-core';
import { createStorageHandle } from '@cashu/coco-core/internal';
import { version } from '../package.json';
import type { SqlDatabase } from './index.ts';
import { SqlStorageRepositories } from './repositories.ts';

export interface SqliteStorageOptions {
  database: SqlDatabase;
  mintSwap?: boolean;
}
/** Create opaque storage using a driver satisfying the public SQLite contract. */
export function createSqliteStorage(options: SqliteStorageOptions): CocoStorage {
  return createStorageHandle(() => new SqlStorageRepositories(options), version);
}
