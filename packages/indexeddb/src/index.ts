import type { CocoStorage } from '@cashu/coco-core';
import { createStorageHandle } from '@cashu/coco-core/internal';
import { version } from '../package.json';
import { IndexedDbRepositories, type IndexedDbRepositoriesOptions } from './internal.ts';

export type IndexedDbStorageOptions = IndexedDbRepositoriesOptions;
export interface IndexedDbStorage extends CocoStorage {
  /** Release the connection after finishing all work. Does not delete Wallet data. */
  close(): void;
}
/** Create storage that owns its IndexedDB connection. init() awaits opening and migrations. */
export function createIndexedDbStorage(options: IndexedDbStorageOptions): IndexedDbStorage {
  let repositories: IndexedDbRepositories | undefined;
  return createStorageHandle<{ close(): void }>(
    () => (repositories ??= new IndexedDbRepositories(options)),
    version,
    {
      close() {
        repositories?.db.close();
      },
    },
  );
}
