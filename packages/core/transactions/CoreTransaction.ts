import { OutputData, type OutputDataCreator } from '@cashu/cashu-ts';
import {
  RepositoryTransactionConflictError,
  type Repositories,
  type RepositoryTransactionScope,
  type SendOperationRepository,
  type ReceiveOperationRepository,
  type MintOperationRepository,
  type MintQuoteRepository,
  type MeltOperationRepository,
  type MeltQuoteRepository,
} from '@core/repositories';
import {
  RepositoryScopedMintMetadata,
  type ScopedMintMetadata,
} from './mints/ScopedMintMetadata.ts';
import { RepositoryScopedProofs, type ScopedProofs } from './proofs/ScopedProofs.ts';
import { RepositoryScopedOutputs, type ScopedOutputs } from './outputs/ScopedOutputs.ts';
import { RepositoryScopedKeypairs, type ScopedKeypairs } from './keypairs/ScopedKeypairs.ts';
import {
  RepositoryScopedMintQuoteClaims,
  type ScopedMintQuoteClaims,
} from './mintQuoteClaims/ScopedMintQuoteClaims.ts';
import { TransactionLifetime } from './TransactionLifetime.ts';
import { getTransitionBody, type Transition } from './Transition.ts';
import type { MintSwapOperationRepository } from '../operations/mintSwap/MintSwapOperationRepository.ts';
import type { BatchMintOperationRepository } from '../operations/batchMint/BatchMintOperationRepository.ts';

/**
 * Scoped capabilities sharing one adapter transaction attempt. Await mutations sequentially unless
 * their independence is established; lifetime tracking does not serialize conflicting work.
 */
export interface CoreTransaction {
  perform<O>(transition: Transition<void, O>): Promise<O>;
  perform<I, O>(transition: Transition<I, O>, input: I): Promise<O>;
  readonly mintMetadata: ScopedMintMetadata;
  readonly keypairs: ScopedKeypairs;
  readonly proofs: ScopedProofs;
  readonly outputs: ScopedOutputs;
  readonly mintQuoteClaims: ScopedMintQuoteClaims;
  readonly mintSwapOperations: Pick<
    MintSwapOperationRepository,
    'getById' | 'getByChild' | 'getByQuote' | 'create' | 'transition'
  >;
  readonly batchMintOperations: Pick<
    BatchMintOperationRepository,
    'getById' | 'listByQuote' | 'create' | 'update'
  >;
  readonly mintOperations: Pick<
    MintOperationRepository,
    'getById' | 'getByQuoteId' | 'create' | 'update' | 'delete'
  >;
  readonly mintQuotes: Pick<MintQuoteRepository, 'getMintQuote'>;
  readonly meltOperations: Pick<
    MeltOperationRepository,
    'getById' | 'getByQuoteId' | 'create' | 'update' | 'delete'
  >;
  readonly meltQuotes: Pick<MeltQuoteRepository, 'getMeltQuote' | 'getMeltQuoteById'>;
  readonly receiveOperations: Pick<
    ReceiveOperationRepository,
    'getById' | 'create' | 'transition' | 'delete'
  >;
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
    const mintMetadata = new RepositoryScopedMintMetadata(
      repositories.mintRepository,
      repositories.keysetRepository,
    );
    const proofs = new RepositoryScopedProofs(
      repositories.proofRepository,
      repositories.keysetRepository,
    );
    const outputs = new RepositoryScopedOutputs(
      repositories.counterRepository,
      repositories.keysetRepository,
      this.outputDataCreator,
    );
    const scoped: CoreTransaction = lifetime.bind({
      // The proxy binds methods to the raw object; bodies must receive the bound scope instead.
      perform: <I, O>(transition: Transition<I, O>, input?: I): Promise<O> =>
        getTransitionBody(transition)(scoped, input as I),
      mintOperations: repositories.mintOperationRepository,
      mintQuotes: repositories.mintQuoteRepository,
      meltOperations: repositories.meltOperationRepository,
      meltQuotes: repositories.meltQuoteRepository,
      mintSwapOperations: repositories.mintSwap.operationRepository,
      batchMintOperations: repositories.batchMint.operationRepository,
      mintMetadata,
      keypairs: new RepositoryScopedKeypairs(repositories.keyRingRepository),
      proofs,
      outputs,
      mintQuoteClaims: new RepositoryScopedMintQuoteClaims(
        repositories.mintOperationRepository,
        repositories.batchMint.operationRepository,
      ),
      receiveOperations: repositories.receiveOperationRepository,
      sendOperations: repositories.sendOperationRepository,
    });
    return scoped;
  }
}
