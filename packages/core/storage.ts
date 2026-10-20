import { MemoryRepositories } from './repositories/memory/MemoryRepositories.ts';
import { createStorageHandle } from './storageInternal.ts';

declare const storageBrand: unique symbol;

/** Opaque persistence selected through a Coco storage factory. */
export interface CocoStorage {
  readonly [storageBrand]: true;
  /** Prepare the database and await all required migrations. */
  init(): Promise<void>;
}

/** Create transient storage. Data lives for the lifetime of this handle. */
export function createMemoryStorage(): CocoStorage {
  return createStorageHandle(() => new MemoryRepositories());
}
