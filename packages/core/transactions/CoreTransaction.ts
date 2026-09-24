import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';
import {
  RepositoryTransactionConflictError,
  type Repositories,
  type RepositoryTransactionScope,
  type SendOperationRepository,
} from '@core/repositories';
import {
  RepositoryTransactionMintMetadata,
  type TransactionMintMetadata,
} from './mints/TransactionMintMetadata.ts';
import { RepositoryTransactionProofs, type TransactionProofs } from './proofs/TransactionProofs.ts';
import {
  RepositoryTransactionOutputs,
  type TransactionOutputs,
} from './outputs/TransactionOutputs.ts';
import {
  RepositoryTransactionKeypairs,
  type TransactionKeypairs,
} from './keypairs/TransactionKeypairs.ts';
import { TransactionLifetime } from './TransactionLifetime.ts';
import { getTransitionBody, type Transition } from './Transition.ts';

/**
 * Scoped capabilities sharing one adapter transaction attempt. Await mutations sequentially unless
 * their independence is established; lifetime tracking does not serialize conflicting work.
 */
export interface CoreTransaction {
  perform<O>(transition: Transition<void, O>): Promise<O>;
  perform<I, O>(transition: Transition<I, O>, input: I): Promise<O>;
  readonly mintMetadata: TransactionMintMetadata;
  readonly keypairs: TransactionKeypairs;
  readonly proofs: TransactionProofs;
  readonly outputs: TransactionOutputs;
  readonly sendOperations: Pick<
    SendOperationRepository,
    'getById' | 'getByMintUrl' | 'create' | 'transition' | 'delete'
  >;
}

/** Injected into coordinators; each invocation resolves only after its local work commits. */
export interface CoreTransactionRunner {
  run<T>(work: (tx: CoreTransaction) => Promise<T>): Promise<T>;
}

const MAX_TRANSACTION_ATTEMPTS = 3;

/** Internal adapter-backed transaction runner owned by the composition root. */
export class RepositoryCoreTransactionRunner implements CoreTransactionRunner {
  constructor(
    private readonly repositories: Repositories,
    private readonly outputDataCreator: OutputDataCreator = OutputData,
  ) {}

  async run<T>(work: (tx: CoreTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.repositories.withTransaction((repositories) => {
          const lifetime = new TransactionLifetime();
          return lifetime.run(() =>
            work(this.createTransaction(lifetime.bind(repositories), lifetime)),
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

  private createTransaction(
    repositories: RepositoryTransactionScope,
    lifetime: TransactionLifetime,
  ): CoreTransaction {
    const mintMetadata = new RepositoryTransactionMintMetadata(
      repositories.mintRepository,
      repositories.keysetRepository,
    );
    const proofs = new RepositoryTransactionProofs(
      repositories.proofRepository,
      repositories.keysetRepository,
    );
    const outputs = new RepositoryTransactionOutputs(
      repositories.counterRepository,
      repositories.keysetRepository,
      this.outputDataCreator,
    );
    const scoped: CoreTransaction = lifetime.bind({
      // The proxy binds methods to the raw object; bodies must receive the bound scope instead.
      perform: <I, O>(transition: Transition<I, O>, input?: I): Promise<O> =>
        getTransitionBody(transition)(scoped, input as I),
      mintMetadata,
      keypairs: new RepositoryTransactionKeypairs(repositories.keyRingRepository),
      proofs,
      outputs,
      sendOperations: repositories.sendOperationRepository,
    });
    return scoped;
  }
}
