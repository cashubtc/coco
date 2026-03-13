import type {
  RepositoryTransactionScope,
  RepositorySet,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  MeltQuoteRepository,
  HistoryRepository,
  SendOperationRepository,
  MeltOperationRepository,
  ReceiveOperationRepository,
} from '..';
import {
  STORAGE_ACCESS,
  type InternalStorageAdapter,
  type StorageAccess,
} from '../../storage/adapter.ts';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMeltQuoteRepository } from './MemoryMeltQuoteRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';

export class MemoryRepositories implements RepositorySet, InternalStorageAdapter {
  mintRepository: MintRepository;
  keyRingRepository: KeyRingRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
  historyRepository: HistoryRepository;
  sendOperationRepository: SendOperationRepository;
  meltOperationRepository: MeltOperationRepository;
  receiveOperationRepository: ReceiveOperationRepository;

  constructor() {
    this.mintRepository = new MemoryMintRepository();
    this.keyRingRepository = new MemoryKeyRingRepository();
    this.counterRepository = new MemoryCounterRepository();
    this.keysetRepository = new MemoryKeysetRepository();
    this.proofRepository = new MemoryProofRepository();
    this.mintQuoteRepository = new MemoryMintQuoteRepository();
    this.meltQuoteRepository = new MemoryMeltQuoteRepository();
    this.historyRepository = new MemoryHistoryRepository();
    this.sendOperationRepository = new MemorySendOperationRepository();
    this.meltOperationRepository = new MemoryMeltOperationRepository();
    this.receiveOperationRepository = new MemoryReceiveOperationRepository();
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return fn(this);
  }

  [STORAGE_ACCESS](): StorageAccess {
    return {
      repositories: this,
      withTransaction: async <T>(fn: (repos: RepositoryTransactionScope) => Promise<T>) =>
        this.withTransaction(fn),
    };
  }
}
