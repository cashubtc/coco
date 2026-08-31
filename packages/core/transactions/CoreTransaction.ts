import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';
import type { Repositories, RepositoryTransactionScope } from '@core/repositories';
import { RepositoryTransactionConflictError } from '@core/repositories';
import {
  RepositoryTransactionalKeypairOperations,
  type TransactionalKeypairOperations,
} from './keypairs/TransactionalKeypairOperations.ts';
import {
  RepositoryTransactionalSendOperations,
  type TransactionalSendOperations,
} from './send/TransactionalSendOperations.ts';
import {
  RepositoryTransactionalReceiveOperations,
  type TransactionalReceiveOperations,
} from './receive/TransactionalReceiveOperations.ts';

export interface CoreTransaction {
  readonly keypairs: TransactionalKeypairOperations;
  readonly sends: TransactionalSendOperations;
  readonly receives: TransactionalReceiveOperations;
}

export interface CoreTransactionRunner {
  run<T>(command: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}

export interface TransactionModuleFactory {
  create(repositories: RepositoryTransactionScope): CoreTransaction;
}

class RepositoryTransactionModuleFactory implements TransactionModuleFactory {
  constructor(private readonly outputDataCreator: OutputDataCreator = OutputData) {}

  create(repositories: RepositoryTransactionScope): CoreTransaction {
    return {
      keypairs: new RepositoryTransactionalKeypairOperations(repositories.keyRingRepository),
      sends: new RepositoryTransactionalSendOperations(
        repositories.proofRepository,
        repositories.counterRepository,
        repositories.keysetRepository,
        repositories.sendOperationRepository,
        this.outputDataCreator,
      ),
      receives: new RepositoryTransactionalReceiveOperations(
        repositories.counterRepository,
        repositories.keysetRepository,
        repositories.receiveOperationRepository,
        this.outputDataCreator,
      ),
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

export function createCoreTransactionModuleFactory(
  outputDataCreator?: OutputDataCreator,
): TransactionModuleFactory {
  return new RepositoryTransactionModuleFactory(outputDataCreator);
}
