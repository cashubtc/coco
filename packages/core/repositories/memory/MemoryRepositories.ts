import type {
  AuthSessionRepository,
  CounterRepository,
  HistoryProjectionRepository,
  KeyRingRepository,
  KeysetRepository,
  LegacyMintQuoteRepository,
  MeltQuoteRepository,
  MeltOperationRepository,
  MintQuoteRepository,
  MintRepository,
  ProofRepository,
  Repositories,
  RepositoryTransactionScope,
  SendOperationRepository,
  MintOperationRepository,
  MintIssuanceAttemptRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  ReceiveOperationRepository,
} from '..';
import { MemoryAuthSessionRepository } from './MemoryAuthSessionRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryMeltQuoteRepository } from './MemoryMeltQuoteRepository';
import { MemoryLegacyMintQuoteRepository } from './MemoryLegacyMintQuoteRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';
import { MemoryMintOperationRepository } from './MemoryMintOperationRepository';
import { MemoryMintIssuanceAttemptRepository } from './MemoryMintIssuanceAttemptRepository';
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from './MemoryPaymentRequestReceiveRepository';

type MutableContainer = Map<unknown, unknown> | unknown[];

interface MutableContainerSnapshot {
  repository: object;
  property: string;
  value: MutableContainer;
}

/** Deeply clones repository state while retaining domain-object prototypes and shared references. */
function cloneTransactionValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) return value;
  const known = seen.get(value);
  if (known) return known as T;
  if (value instanceof Uint8Array) return value.slice() as T;
  if (value instanceof Map) {
    const clone = new Map();
    seen.set(value, clone);
    for (const [key, item] of value) {
      clone.set(cloneTransactionValue(key, seen), cloneTransactionValue(item, seen));
    }
    return clone as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    clone.push(...value.map((item) => cloneTransactionValue(item, seen)));
    return clone as T;
  }
  const clone = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneTransactionValue(item, seen);
  }
  return clone as T;
}

/** Captures repository-owned mutable containers before entering a memory transaction. */
function snapshotMutableContainers(repositories: object[]): MutableContainerSnapshot[] {
  const snapshots: MutableContainerSnapshot[] = [];
  for (const repository of new Set(repositories)) {
    for (const [property, value] of Object.entries(repository)) {
      if (value instanceof Map || Array.isArray(value)) {
        snapshots.push({
          repository,
          property,
          value: cloneTransactionValue(value),
        });
      }
    }
  }
  return snapshots;
}

/** Restores repository-owned mutable containers when a memory transaction rolls back. */
function restoreMutableContainers(snapshots: MutableContainerSnapshot[]): void {
  for (const snapshot of snapshots) {
    Reflect.set(snapshot.repository, snapshot.property, cloneTransactionValue(snapshot.value));
  }
}

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
  mintOperationRepository: MintOperationRepository;
  mintIssuanceAttemptRepository: MintIssuanceAttemptRepository;
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  private readonly transactionScope: RepositoryTransactionScope;
  private transactionTail: Promise<void> = Promise.resolve();
  private activeOperations = 0;
  private operationsDrained: Promise<void> = Promise.resolve();
  private releaseOperationsDrained?: () => void;

  constructor() {
    const mintRepository = new MemoryMintRepository();
    const keyRingRepository = new MemoryKeyRingRepository();
    const counterRepository = new MemoryCounterRepository();
    const keysetRepository = new MemoryKeysetRepository();
    const proofRepository = new MemoryProofRepository();
    const sendOperationRepository = new MemorySendOperationRepository();
    const meltOperationRepository = new MemoryMeltOperationRepository();
    const mintOperationRepository = new MemoryMintOperationRepository();
    const receiveOperationRepository = new MemoryReceiveOperationRepository();
    const mintIssuanceAttemptRepository = new MemoryMintIssuanceAttemptRepository();
    const mintQuoteRepository = new MemoryMintQuoteRepository();
    const legacyMintQuoteRepository = new MemoryLegacyMintQuoteRepository();
    const meltQuoteRepository = new MemoryMeltQuoteRepository();
    const historyRepository = new MemoryHistoryRepository({
      sendOperationRepository,
      meltOperationRepository,
      mintOperationRepository,
      mintQuoteRepository,
      receiveOperationRepository,
    });
    const authSessionRepository = new MemoryAuthSessionRepository();
    const paymentRequestReceiveOperationRepository =
      new MemoryPaymentRequestReceiveOperationRepository();
    const paymentRequestReceiveAttemptRepository =
      new MemoryPaymentRequestReceiveAttemptRepository();

    const transactionScope: RepositoryTransactionScope = {
      mintRepository,
      keyRingRepository,
      counterRepository,
      keysetRepository,
      proofRepository,
      mintQuoteRepository,
      legacyMintQuoteRepository,
      meltQuoteRepository,
      historyRepository,
      sendOperationRepository,
      meltOperationRepository,
      authSessionRepository,
      mintOperationRepository,
      mintIssuanceAttemptRepository,
      receiveOperationRepository,
      paymentRequestReceiveOperationRepository,
      paymentRequestReceiveAttemptRepository,
      withTransaction: (fn) => fn(transactionScope),
    };
    this.transactionScope = transactionScope;

    this.mintRepository = this.serializeRepository(mintRepository);
    this.keyRingRepository = this.serializeRepository(keyRingRepository);
    this.counterRepository = this.serializeRepository(counterRepository);
    this.keysetRepository = this.serializeRepository(keysetRepository);
    this.proofRepository = this.serializeRepository(proofRepository);
    this.mintQuoteRepository = this.serializeRepository(mintQuoteRepository);
    this.legacyMintQuoteRepository = this.serializeRepository(legacyMintQuoteRepository);
    this.meltQuoteRepository = this.serializeRepository(meltQuoteRepository);
    this.historyRepository = this.serializeRepository(historyRepository);
    this.sendOperationRepository = this.serializeRepository(sendOperationRepository);
    this.meltOperationRepository = this.serializeRepository(meltOperationRepository);
    this.authSessionRepository = this.serializeRepository(authSessionRepository);
    this.mintOperationRepository = this.serializeRepository(mintOperationRepository);
    this.mintIssuanceAttemptRepository = this.serializeRepository(mintIssuanceAttemptRepository);
    this.receiveOperationRepository = this.serializeRepository(receiveOperationRepository);
    this.paymentRequestReceiveOperationRepository = this.serializeRepository(
      paymentRequestReceiveOperationRepository,
    );
    this.paymentRequestReceiveAttemptRepository = this.serializeRepository(
      paymentRequestReceiveAttemptRepository,
    );
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  /**
   * Serializes memory transactions and restores repository containers when a callback fails.
   * Root repository calls wait for an active transaction so they cannot leak into its snapshot.
   * Calls through the callback's transaction scope roll into the active transaction.
   */
  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    const previousTransaction = this.transactionTail;
    let releaseTransaction!: () => void;
    const currentTransaction = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    this.transactionTail = previousTransaction.then(() => currentTransaction);

    await previousTransaction;
    await this.operationsDrained;
    try {
      const snapshots = snapshotMutableContainers(
        Object.values(this.transactionScope).filter(
          (value): value is object => typeof value === 'object',
        ),
      );
      try {
        return await fn(this.transactionScope);
      } catch (error) {
        restoreMutableContainers(snapshots);
        throw error;
      }
    } finally {
      releaseTransaction();
    }
  }

  /** Wraps root repositories so calls wait for any active memory transaction. */
  private serializeRepository<T extends object>(repository: T): T {
    return new Proxy(repository, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          this.runRepositoryOperation(() => Reflect.apply(value, target, args) as unknown);
      },
    });
  }

  /** Tracks root operations so a transaction can snapshot only after prior calls drain. */
  private async runRepositoryOperation<T>(fn: () => T | Promise<T>): Promise<T> {
    while (true) {
      const transaction = this.transactionTail;
      await transaction;
      if (transaction === this.transactionTail) break;
    }

    if (this.activeOperations === 0) {
      this.operationsDrained = new Promise<void>((resolve) => {
        this.releaseOperationsDrained = resolve;
      });
    }
    this.activeOperations += 1;
    try {
      return await fn();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        this.releaseOperationsDrained?.();
        this.releaseOperationsDrained = undefined;
      }
    }
  }
}
