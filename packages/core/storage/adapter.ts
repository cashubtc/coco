import type { RepositorySet, RepositoryTransactionScope } from '../repositories/index.ts';
import {
  STORAGE_ACCESS,
  type CocoStorage,
  type CreateStorageAdapterOptions,
  type InternalStorageAdapter,
  type StorageAccess,
} from './types.ts';

export { STORAGE_ACCESS };
export type { StorageAccess, InternalStorageAdapter, CreateStorageAdapterOptions };

export function createInternalStorageAdapter(
  options: CreateStorageAdapterOptions,
): InternalStorageAdapter {
  return {
    init: options.init,
    [STORAGE_ACCESS]: () => ({
      repositories: options.repositories,
      withTransaction: options.withTransaction,
    }),
  };
}

export function getStorageAccess(storage: CocoStorage): StorageAccess {
  const getAccess = (storage as Partial<InternalStorageAdapter>)[STORAGE_ACCESS];
  if (typeof getAccess !== 'function') {
    throw new Error(
      'Invalid Coco storage adapter. Use a storage implementation built for this core version.',
    );
  }
  return getAccess.call(storage);
}

export function getStorageRepositories(storage: CocoStorage): RepositorySet {
  return getStorageAccess(storage).repositories;
}

export function withStorageTransaction<T>(
  storage: CocoStorage,
  fn: (repos: RepositoryTransactionScope) => Promise<T>,
): Promise<T> {
  return getStorageAccess(storage).withTransaction(fn);
}
