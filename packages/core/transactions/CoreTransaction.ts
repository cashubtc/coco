import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';
import type { Repositories, RepositoryTransactionScope } from '@core/repositories';
import { RepositoryTransactionConflictError } from '@core/repositories';
import {
  RepositoryKeypairCommands,
  type ScopedKeypairCommands,
} from './scoped/keypairs/ScopedKeypairCommands.ts';
import {
  RepositoryMintCommands,
  type ScopedMintCommands,
} from './scoped/mint/ScopedMintCommands.ts';
import {
  RepositoryMintMetadataCommands,
  type ScopedMintMetadataCommands,
} from './scoped/mints/ScopedMintMetadataCommands.ts';
import {
  RepositoryOutputCommands,
  type ScopedOutputCommands,
} from './scoped/outputs/ScopedOutputCommands.ts';
import { TransactionLifetime } from './scoped/TransactionLifetime.ts';

/**
 * Scoped commands sharing one adapter transaction attempt. Await mutations sequentially unless
 * their independence is established; lifetime tracking does not serialize conflicting work.
 */
export interface CoreTransaction {
  readonly mintMetadata: ScopedMintMetadataCommands;
  readonly outputs: ScopedOutputCommands;
  readonly keypairs: ScopedKeypairCommands;
  readonly mints: ScopedMintCommands;
}

export interface CoreTransactionRunner {
  run<T>(work: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}

type TransactionModuleFactory = (repositories: RepositoryTransactionScope) => CoreTransaction;

export function createCoreTransactionModuleFactory(
  outputDataCreator: OutputDataCreator = OutputData,
): TransactionModuleFactory {
  return (repositories) => {
    const outputs = new RepositoryOutputCommands(
      repositories.counterRepository,
      repositories.keysetRepository,
      outputDataCreator,
    );
    return {
      mintMetadata: new RepositoryMintMetadataCommands(
        repositories.mintRepository,
        repositories.keysetRepository,
      ),
      outputs,
      keypairs: new RepositoryKeypairCommands(repositories.keyRingRepository),
      mints: new RepositoryMintCommands(repositories, outputs),
    };
  };
}

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Internal adapter-backed transaction runner owned by the composition root. */
export class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  constructor(
    private readonly repositories: Repositories,
    private readonly createModules: TransactionModuleFactory = createCoreTransactionModuleFactory(),
  ) {}

  async run<T>(work: (transaction: CoreTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repositories.withTransaction((repositories) => {
          const lifetime = new TransactionLifetime();
          return lifetime.run(() =>
            work(lifetime.bind(this.createModules(lifetime.bind(repositories)))),
          );
        });
      } catch (error) {
        if (
          !(error instanceof RepositoryTransactionConflictError) ||
          attempt >= MAX_TRANSACTION_ATTEMPTS
        ) {
          throw error;
        }
        // Yield outside the failed transaction so competing writers can finish before retrying.
        await new Promise((resolve) => setTimeout(resolve, attempt * 5));
      }
    }
  }
}
