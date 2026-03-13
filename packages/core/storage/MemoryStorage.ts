import { MemoryRepositories } from '../repositories/memory/MemoryRepositories.ts';
import type { RepositoryTransactionScope } from '../repositories/index.ts';
import { STORAGE_ACCESS, type InternalStorageAdapter } from './adapter.ts';

export class MemoryStorage implements InternalStorageAdapter {
  readonly #repositories = new MemoryRepositories();

  async init(): Promise<void> {
    await this.#repositories.init();
  }

  [STORAGE_ACCESS]() {
    return {
      repositories: this.#repositories,
      withTransaction: async <T>(fn: (repos: RepositoryTransactionScope) => Promise<T>) =>
        this.#repositories.withTransaction(fn),
    };
  }
}
