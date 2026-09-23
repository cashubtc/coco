import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';
import {
  RepositoryTransactionConflictError,
  type Repositories,
  type RepositoryTransactionScope,
  type SendOperationRepository,
} from '@core/repositories';
import {
  RepositoryMintMetadataCommands,
  type MintMetadataCommands,
} from './mints/MintMetadataCommands.ts';
import { RepositoryProofCommands, type ProofCommands } from './proofs/ProofCommands.ts';
import { RepositoryOutputCommands, type OutputCommands } from './outputs/OutputCommands.ts';
import { RepositoryKeypairCommands, type KeypairCommands } from './keypairs/KeypairCommands.ts';
import { TransactionLifetime } from './TransactionLifetime.ts';

/**
 * Scoped commands sharing one adapter transaction attempt. Await mutations sequentially unless
 * their independence is established; lifetime tracking does not serialize conflicting work.
 */
export interface CoreTransaction {
  readonly mintMetadata: MintMetadataCommands;
  readonly keypairs: KeypairCommands;
  readonly proofs: ProofCommands;
  readonly outputs: OutputCommands;
  readonly sendOperations: Pick<
    SendOperationRepository,
    'getById' | 'getByMintUrl' | 'create' | 'transition' | 'delete'
  >;
}

/** Injected into coordinators; each invocation resolves only after its local work commits. */
export interface CoreTransactionRunner {
  run<T>(work: (transaction: CoreTransaction) => Promise<T>): Promise<T>;
}

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Internal adapter-backed transaction runner owned by the composition root. */
export class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  constructor(
    private readonly repositories: Repositories,
    private readonly outputDataCreator: OutputDataCreator = OutputData,
  ) {}

  async run<T>(work: (transaction: CoreTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repositories.withTransaction((repositories) => {
          const lifetime = new TransactionLifetime();
          return lifetime.run(() =>
            work(lifetime.bind(this.createTransaction(lifetime.bind(repositories)))),
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

  private createTransaction(repositories: RepositoryTransactionScope): CoreTransaction {
    const mintMetadata = new RepositoryMintMetadataCommands(
      repositories.mintRepository,
      repositories.keysetRepository,
    );
    const proofs = new RepositoryProofCommands(
      repositories.proofRepository,
      repositories.keysetRepository,
    );
    const outputs = new RepositoryOutputCommands(
      repositories.counterRepository,
      repositories.keysetRepository,
      this.outputDataCreator,
    );
    return {
      mintMetadata,
      keypairs: new RepositoryKeypairCommands(repositories.keyRingRepository),
      proofs,
      outputs,
      sendOperations: repositories.sendOperationRepository,
    };
  }
}
