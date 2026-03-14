import type {
  AuthSessionRepository,
  CounterRepository,
  HistoryRepository,
  KeyRingRepository,
  KeysetRepository,
  MeltOperationRepository,
  MeltQuoteRepository,
  MintQuoteRepository,
  MintRepository,
  ProofRepository,
  Repositories,
  RepositoryTransactionScope,
  SendOperationRepository,
} from '..';
import { MemoryAuthSessionRepository } from './MemoryAuthSessionRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryMeltQuoteRepository } from './MemoryMeltQuoteRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';

export class MemoryRepositories implements Repositories {
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
  authSessionRepository: AuthSessionRepository;

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
    this.authSessionRepository = new MemoryAuthSessionRepository();
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
