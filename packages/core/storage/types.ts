import type { RepositorySet, RepositoryTransactionScope } from '../repositories/index.ts';

export const STORAGE_ACCESS = Symbol('coco-cashu.storage-access');

export interface StorageAccess {
  repositories: RepositorySet;
  withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T>;
}

export interface CocoStorage {
  init(): Promise<void>;
}

export interface InternalStorageAdapter extends CocoStorage {
  [STORAGE_ACCESS](): StorageAccess;
}

export interface CreateStorageAdapterOptions {
  init(): Promise<void>;
  repositories: RepositorySet;
  withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T>;
}
