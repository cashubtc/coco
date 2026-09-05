import type {
  AuthSessionRepository,
  CounterRepository,
  HistoryProjectionRepository,
  KeyRingRepository,
  KeysetRepository,
  LegacyMintQuoteRepository,
  MeltOperationRepository,
  MeltQuoteRepository,
  MintOperationRepository,
  MintQuoteRepository,
  MintRecoveryRepository,
  MintRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  ProofRepository,
  ReceiveOperationRepository,
  Repositories,
  RepositoryTransactionScope,
  SendOperationRepository,
} from '..';
import { MemoryAuthSessionRepository } from './MemoryAuthSessionRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryLegacyMintQuoteRepository } from './MemoryLegacyMintQuoteRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryMeltQuoteRepository } from './MemoryMeltQuoteRepository';
import { MemoryMintOperationRepository } from './MemoryMintOperationRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMintRecoveryRepository } from './MemoryMintRecoveryRepository.ts';
import { MemoryMintRepository } from './MemoryMintRepository';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from './MemoryPaymentRequestReceiveRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import {
  COPY_MEMORY_REPOSITORY_STATE,
  type MemoryRepositoryStateOwner,
} from './MemoryRepositoryTransaction.ts';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';

export class MemoryRepositories implements Repositories {
  mintRepository: MintRepository;
  keyRingRepository: KeyRingRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  legacyMintQuoteRepository: LegacyMintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
  historyRepository: HistoryProjectionRepository;
  sendOperationRepository: SendOperationRepository;
  meltOperationRepository: MeltOperationRepository;
  authSessionRepository: AuthSessionRepository;
  mintRecoveryRepository: MintRecoveryRepository;
  mintOperationRepository: MintOperationRepository;
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;

  private readonly state: MemoryRepositoryState;
  private transactionQueue: Promise<void> = Promise.resolve();
  private pendingTransactionCount = 0;
  private activeRootOperationCount = 0;
  private rootOperationsIdle: Promise<void> = Promise.resolve();
  private releaseRootOperations!: () => void;

  constructor() {
    this.state = createMemoryRepositoryState();
    this.mintRecoveryRepository = this.wrapRootRepository(this.state.mintRecoveryRepository);
    this.mintRepository = this.wrapRootRepository(this.state.mintRepository);
    this.keyRingRepository = this.wrapRootRepository(this.state.keyRingRepository);
    this.counterRepository = this.wrapRootRepository(this.state.counterRepository);
    this.keysetRepository = this.wrapRootRepository(this.state.keysetRepository);
    this.proofRepository = this.wrapRootRepository(this.state.proofRepository);
    this.mintQuoteRepository = this.wrapRootRepository(this.state.mintQuoteRepository);
    this.legacyMintQuoteRepository = this.wrapRootRepository(this.state.legacyMintQuoteRepository);
    this.meltQuoteRepository = this.wrapRootRepository(this.state.meltQuoteRepository);
    this.historyRepository = this.wrapRootRepository(this.state.historyRepository);
    this.sendOperationRepository = this.wrapRootRepository(this.state.sendOperationRepository);
    this.meltOperationRepository = this.wrapRootRepository(this.state.meltOperationRepository);
    this.authSessionRepository = this.wrapRootRepository(this.state.authSessionRepository);
    this.mintOperationRepository = this.wrapRootRepository(this.state.mintOperationRepository);
    this.receiveOperationRepository = this.wrapRootRepository(
      this.state.receiveOperationRepository,
    );
    this.paymentRequestReceiveOperationRepository = this.wrapRootRepository(
      this.state.paymentRequestReceiveOperationRepository,
    );
    this.paymentRequestReceiveAttemptRepository = this.wrapRootRepository(
      this.state.paymentRequestReceiveAttemptRepository,
    );
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    // Reserve a queue position before waiting so new root operations cannot slip between writers.
    const previousTransaction = this.transactionQueue;
    let releaseTransaction!: () => void;
    this.transactionQueue = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    this.pendingTransactionCount++;

    try {
      await previousTransaction;
      await this.rootOperationsIdle;

      // The callback only sees a detached snapshot. Copying it back is the atomic commit point.
      const staged = cloneMemoryRepositoryState(this.state);
      const result = await fn(staged);
      copyMemoryRepositoryState(this.state, staged);
      return result;
    } finally {
      this.pendingTransactionCount--;
      releaseTransaction();
    }
  }

  private wrapRootRepository<T extends object>(repository: T): T {
    // Root repository calls share the transaction gate while scoped repositories stay detached.
    return new Proxy(repository, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          this.runRootOperation(() => Reflect.apply(value, target, args));
      },
    });
  }

  private async runRootOperation<T>(operation: () => T | Promise<T>): Promise<T> {
    while (this.pendingTransactionCount > 0) {
      await this.transactionQueue;
    }
    this.beginRootOperation();
    try {
      return await operation();
    } finally {
      this.endRootOperation();
    }
  }

  private beginRootOperation(): void {
    if (this.activeRootOperationCount === 0) {
      this.rootOperationsIdle = new Promise<void>((resolve) => {
        this.releaseRootOperations = resolve;
      });
    }
    this.activeRootOperationCount++;
  }

  private endRootOperation(): void {
    this.activeRootOperationCount--;
    if (this.activeRootOperationCount === 0) this.releaseRootOperations();
  }
}

type MemoryRepositoryState = ReturnType<typeof createMemoryRepositoryState>;

function createMemoryRepositoryState() {
  const sendOperationRepository = new MemorySendOperationRepository();
  const meltOperationRepository = new MemoryMeltOperationRepository();
  const mintOperationRepository = new MemoryMintOperationRepository();
  const receiveOperationRepository = new MemoryReceiveOperationRepository();
  const mintQuoteRepository = new MemoryMintQuoteRepository();

  const state = {
    mintRecoveryRepository: new MemoryMintRecoveryRepository(),
    mintRepository: new MemoryMintRepository(),
    keyRingRepository: new MemoryKeyRingRepository(),
    counterRepository: new MemoryCounterRepository(),
    keysetRepository: new MemoryKeysetRepository(),
    proofRepository: new MemoryProofRepository(),
    mintQuoteRepository,
    legacyMintQuoteRepository: new MemoryLegacyMintQuoteRepository(),
    meltQuoteRepository: new MemoryMeltQuoteRepository(),
    historyRepository: new MemoryHistoryRepository({
      sendOperationRepository,
      meltOperationRepository,
      mintOperationRepository,
      mintQuoteRepository,
      receiveOperationRepository,
    }),
    sendOperationRepository,
    meltOperationRepository,
    authSessionRepository: new MemoryAuthSessionRepository(),
    mintOperationRepository,
    receiveOperationRepository,
    paymentRequestReceiveOperationRepository: new MemoryPaymentRequestReceiveOperationRepository(),
    paymentRequestReceiveAttemptRepository: new MemoryPaymentRequestReceiveAttemptRepository(),
  };

  type StateOwnerConstraint = {
    [Key in keyof typeof state]: MemoryRepositoryStateOwner<(typeof state)[Key]>;
  };
  return state satisfies StateOwnerConstraint;
}

function cloneMemoryRepositoryState(source: MemoryRepositoryState): MemoryRepositoryState {
  const clone = createMemoryRepositoryState();
  copyMemoryRepositoryState(clone, source);
  return clone;
}

function copyMemoryRepositoryState(
  target: MemoryRepositoryState,
  source: MemoryRepositoryState,
): void {
  for (const key of Object.keys(source) as (keyof MemoryRepositoryState)[]) {
    // createMemoryRepositoryState statically enforces the protocol; this loop loses key correlation.
    const targetRepository = target[key] as MemoryRepositoryStateOwner<object>;
    targetRepository[COPY_MEMORY_REPOSITORY_STATE](source[key]);
  }
}
