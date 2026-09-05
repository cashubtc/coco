import type { Repositories } from '../repositories/index.ts';
import { RepositoryTransactionConflictError } from '../repositories/index.ts';
import {
  RepositoryMintCommands,
  type TransactionScopedMintCommands,
} from './scoped/mint/TransactionScopedMintCommands.ts';

export interface CoreTransaction {
  readonly mints: TransactionScopedMintCommands;
}
export interface CoreTransactionRunner {
  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}

/** Composition-root mechanism. Scoped commands never retain or acquire this runner. */
export class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  constructor(private readonly repositories: Repositories) {}
  async run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repositories.withTransaction((scope) =>
          command({ mints: new RepositoryMintCommands(scope) }),
        );
      } catch (error) {
        if (!(error instanceof RepositoryTransactionConflictError) || attempt >= 3) throw error;
      }
    }
  }
}
