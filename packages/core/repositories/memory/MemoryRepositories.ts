import type {
  AuthSessionRepository,
  CounterRepository,
  HistoryProjectionRepository,
  KeyRingRepository,
  KeysetRepository,
  MeltOperationRepository,
  MintQuoteRepository,
  MintRepository,
  ProofRepository,
  Repositories,
  RepositoryTransactionScope,
  SendOperationRepository,
  MintOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  MintBatchAttemptRepository,
  ReceiveOperationRepository,
} from '..';
import { MemoryAuthSessionRepository } from './MemoryAuthSessionRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';
import { MemoryMintOperationRepository } from './MemoryMintOperationRepository';
import { MemoryMintBatchAttemptRepository } from './MemoryMintBatchAttemptRepository';
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from './MemoryPaymentRequestReceiveRepository';

export class MemoryRepositories implements Repositories {
  mintRepository: MintRepository;
  keyRingRepository: KeyRingRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  historyRepository: HistoryProjectionRepository;
  sendOperationRepository: SendOperationRepository;
  meltOperationRepository: MeltOperationRepository;
  authSessionRepository: AuthSessionRepository;
  mintOperationRepository: MintOperationRepository;
  mintBatchAttemptRepository: MintBatchAttemptRepository;
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;

  constructor() {
    this.mintRepository = new MemoryMintRepository();
    this.keyRingRepository = new MemoryKeyRingRepository();
    this.counterRepository = new MemoryCounterRepository();
    this.keysetRepository = new MemoryKeysetRepository();
    this.proofRepository = new MemoryProofRepository();
    const sendOperationRepository = new MemorySendOperationRepository();
    const meltOperationRepository = new MemoryMeltOperationRepository();
    const mintOperationRepository = new MemoryMintOperationRepository();
    const receiveOperationRepository = new MemoryReceiveOperationRepository();

    this.sendOperationRepository = sendOperationRepository;
    this.meltOperationRepository = meltOperationRepository;
    this.mintOperationRepository = mintOperationRepository;
    this.receiveOperationRepository = receiveOperationRepository;
    this.mintQuoteRepository = new MemoryMintQuoteRepository();
    this.historyRepository = new MemoryHistoryRepository({
      sendOperationRepository,
      meltOperationRepository,
      mintOperationRepository,
      receiveOperationRepository,
    });
    this.authSessionRepository = new MemoryAuthSessionRepository();
    this.paymentRequestReceiveOperationRepository =
      new MemoryPaymentRequestReceiveOperationRepository();
    this.paymentRequestReceiveAttemptRepository =
      new MemoryPaymentRequestReceiveAttemptRepository();
    this.mintBatchAttemptRepository = new MemoryMintBatchAttemptRepository();
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return fn(this);
  }
}
