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

  constructor() {
    this.mintRepository = new MemoryMintRepository();
    this.keyRingRepository = new MemoryKeyRingRepository();
    const counterRepository = new MemoryCounterRepository();
    this.counterRepository = counterRepository;
    this.keysetRepository = new MemoryKeysetRepository();
    const proofRepository = new MemoryProofRepository();
    this.proofRepository = proofRepository;
    const sendOperationRepository = new MemorySendOperationRepository();
    const meltOperationRepository = new MemoryMeltOperationRepository();
    const mintOperationRepository = new MemoryMintOperationRepository();
    const receiveOperationRepository = new MemoryReceiveOperationRepository();

    this.sendOperationRepository = sendOperationRepository;
    this.meltOperationRepository = meltOperationRepository;
    this.mintOperationRepository = mintOperationRepository;
    const mintIssuanceAttemptRepository = new MemoryMintIssuanceAttemptRepository();
    this.mintIssuanceAttemptRepository = mintIssuanceAttemptRepository;
    this.receiveOperationRepository = receiveOperationRepository;
    this.mintQuoteRepository = new MemoryMintQuoteRepository();
    this.legacyMintQuoteRepository = new MemoryLegacyMintQuoteRepository();
    this.meltQuoteRepository = new MemoryMeltQuoteRepository();
    this.historyRepository = new MemoryHistoryRepository({
      sendOperationRepository,
      meltOperationRepository,
      mintOperationRepository,
      mintQuoteRepository: this.mintQuoteRepository,
      receiveOperationRepository,
    });
    this.authSessionRepository = new MemoryAuthSessionRepository();
    this.paymentRequestReceiveOperationRepository =
      new MemoryPaymentRequestReceiveOperationRepository();
    this.paymentRequestReceiveAttemptRepository =
      new MemoryPaymentRequestReceiveAttemptRepository();
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    const snapshots = snapshotMutableContainers(
      Object.values(this).filter((value): value is object => typeof value === 'object'),
    );
    try {
      return await fn(this);
    } catch (error) {
      restoreMutableContainers(snapshots);
      throw error;
    }
  }
}
