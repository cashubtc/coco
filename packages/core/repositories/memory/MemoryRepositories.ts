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
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  ReceiveOperationRepository,
  MintSwapOperationRepository,
  OperationEventOutboxRepository,
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
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from './MemoryPaymentRequestReceiveRepository';
import { MemoryMintSwapOperationRepository } from './MemoryMintSwapOperationRepository';
import { MemoryOperationEventOutboxRepository } from './MemoryOperationEventOutboxRepository';
import { copyMemoryRepositoryState } from './clone';

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
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  mintSwapOperationRepository: MintSwapOperationRepository;
  operationEventOutboxRepository: OperationEventOutboxRepository;

  private transactionTail: Promise<void> = Promise.resolve();

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
    this.mintSwapOperationRepository = new MemoryMintSwapOperationRepository();
    this.operationEventOutboxRepository = new MemoryOperationEventOutboxRepository();
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      const staged = new MemoryRepositories();
      this.copyRepositoryStates(this, staged);
      const result = await fn(staged);
      this.copyRepositoryStates(staged, this);
      return result;
    } finally {
      release();
    }
  }

  private copyRepositoryStates(source: MemoryRepositories, target: MemoryRepositories): void {
    const repositoryKeys: Array<keyof RepositoryTransactionScope> = [
      'mintRepository',
      'keyRingRepository',
      'counterRepository',
      'keysetRepository',
      'proofRepository',
      'mintQuoteRepository',
      'legacyMintQuoteRepository',
      'meltQuoteRepository',
      'historyRepository',
      'sendOperationRepository',
      'meltOperationRepository',
      'authSessionRepository',
      'mintOperationRepository',
      'receiveOperationRepository',
      'paymentRequestReceiveOperationRepository',
      'paymentRequestReceiveAttemptRepository',
      'mintSwapOperationRepository',
      'operationEventOutboxRepository',
    ];
    for (const key of repositoryKeys) {
      copyMemoryRepositoryState(
        source[key],
        target[key],
        key === 'historyRepository' ? ['operationRepositories'] : [],
      );
    }
  }
}
