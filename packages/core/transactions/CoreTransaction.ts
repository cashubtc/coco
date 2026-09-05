import type { Repositories, RepositoryTransactionScope } from '@core/repositories';
import { RepositoryTransactionConflictError } from '@core/repositories';
import {
  RepositoryKeypairCommands,
  type TransactionScopedKeypairCommands,
} from './scoped/keypairs/TransactionScopedKeypairCommands.ts';

export interface CoreTransaction {
  readonly keypairs: TransactionScopedKeypairCommands;
}

export interface CoreTransactionRunner {
  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}

interface TransactionModuleFactory {
  create(repositories: RepositoryTransactionScope): CoreTransaction;
}

class RepositoryTransactionModuleFactory implements TransactionModuleFactory {
  create(repositories: RepositoryTransactionScope): CoreTransaction {
    return {
      keypairs: new RepositoryKeypairCommands(repositories.keyRingRepository),
    };
  }
}

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Internal adapter-backed transaction runner owned by the composition root. */
export class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  private readonly modules: TransactionModuleFactory;

  constructor(
    private readonly repositories: Repositories,
    modules: TransactionModuleFactory = new RepositoryTransactionModuleFactory(),
  ) {
    this.modules = modules;
  }

  async run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repositories.withTransaction((repositories) =>
          command(this.modules.create(repositories)),
        );
      } catch (error) {
        if (
          !(error instanceof RepositoryTransactionConflictError) ||
          attempt >= MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
      }
    }
  }
}
