import type {
  DurableEventOutboxHostTransactionScope,
  DurableEventOutboxTransactionPort,
  DurableEventStorageLimits,
  Repositories,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MeltQuoteRepository,
  MintQuoteRepository,
  LegacyMintQuoteRepository,
  SendOperationRepository,
  MeltOperationRepository,
  AuthSessionRepository,
  MintOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  ReceiveOperationRepository,
  RepositoryTransactionScope,
} from '@cashu/coco-core/adapter';
import { IdbDb, type IdbDbOptions } from './lib/db.ts';
import { ensureSchema } from './lib/schema.ts';
import { IdbMintRepository } from './repositories/MintRepository.ts';
import { IdbKeysetRepository } from './repositories/KeysetRepository.ts';
import { IdbKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { IdbCounterRepository } from './repositories/CounterRepository.ts';
import { IdbProofRepository } from './repositories/ProofRepository.ts';
import { IdbMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { IdbMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { IdbLegacyMintQuoteRepository } from './repositories/LegacyMintQuoteRepository.ts';
import { IdbHistoryRepository } from './repositories/HistoryRepository.ts';
import { IdbSendOperationRepository } from './repositories/SendOperationRepository.ts';
import { IdbMeltOperationRepository } from './repositories/MeltOperationRepository.ts';
import { IdbAuthSessionRepository } from './repositories/AuthSessionRepository.ts';
import { IdbMintOperationRepository } from './repositories/MintOperationRepository.ts';
import { IdbReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import {
  IdbPaymentRequestReceiveAttemptRepository,
  IdbPaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';
import {
  configureIdbDurableEventOutboxStorageLimits,
  IdbDurableEventOutboxRepository,
  IDB_DURABLE_EVENT_OUTBOX_STORES,
} from './repositories/DurableEventOutboxRepository.ts';
import { IdbDurableEventOutboxTransactionPort } from './repositories/DurableEventOutboxTransactionPort.ts';

export interface IndexedDbRepositoriesOptions extends IdbDbOptions {}

export type IdbDurableEventOutboxTransactionScope =
  DurableEventOutboxHostTransactionScope<RepositoryTransactionScope>;

function createRepositoryScope(database: IdbDb): RepositoryTransactionScope {
  return {
    mintRepository: new IdbMintRepository(database),
    keyRingRepository: new IdbKeyRingRepository(database),
    counterRepository: new IdbCounterRepository(database),
    keysetRepository: new IdbKeysetRepository(database),
    proofRepository: new IdbProofRepository(database),
    meltQuoteRepository: new IdbMeltQuoteRepository(database),
    mintQuoteRepository: new IdbMintQuoteRepository(database),
    legacyMintQuoteRepository: new IdbLegacyMintQuoteRepository(database),
    historyRepository: new IdbHistoryRepository(database),
    sendOperationRepository: new IdbSendOperationRepository(database),
    meltOperationRepository: new IdbMeltOperationRepository(database),
    authSessionRepository: new IdbAuthSessionRepository(database),
    mintOperationRepository: new IdbMintOperationRepository(database),
    receiveOperationRepository: new IdbReceiveOperationRepository(database),
    paymentRequestReceiveOperationRepository: new IdbPaymentRequestReceiveOperationRepository(
      database,
    ),
    paymentRequestReceiveAttemptRepository: new IdbPaymentRequestReceiveAttemptRepository(database),
  };
}

export class IndexedDbRepositories implements Repositories {
  readonly durableEventOutbox: DurableEventOutboxTransactionPort;
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly legacyMintQuoteRepository: LegacyMintQuoteRepository;
  readonly historyRepository: IdbHistoryRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly authSessionRepository: AuthSessionRepository;
  readonly mintOperationRepository: MintOperationRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly db: IdbDb;
  private initialized = false;

  constructor(options: IndexedDbRepositoriesOptions) {
    this.db = new IdbDb(options);
    this.durableEventOutbox = new IdbDurableEventOutboxTransactionPort(this.db);
    this.mintRepository = new IdbMintRepository(this.db);
    this.keyRingRepository = new IdbKeyRingRepository(this.db);
    this.counterRepository = new IdbCounterRepository(this.db);
    this.keysetRepository = new IdbKeysetRepository(this.db);
    this.proofRepository = new IdbProofRepository(this.db);
    this.meltQuoteRepository = new IdbMeltQuoteRepository(this.db);
    this.mintQuoteRepository = new IdbMintQuoteRepository(this.db);
    this.legacyMintQuoteRepository = new IdbLegacyMintQuoteRepository(this.db);
    this.historyRepository = new IdbHistoryRepository(this.db);
    this.sendOperationRepository = new IdbSendOperationRepository(this.db);
    this.meltOperationRepository = new IdbMeltOperationRepository(this.db);
    this.authSessionRepository = new IdbAuthSessionRepository(this.db);
    this.mintOperationRepository = new IdbMintOperationRepository(this.db);
    this.receiveOperationRepository = new IdbReceiveOperationRepository(this.db);
    this.paymentRequestReceiveOperationRepository = new IdbPaymentRequestReceiveOperationRepository(
      this.db,
    );
    this.paymentRequestReceiveAttemptRepository = new IdbPaymentRequestReceiveAttemptRepository(
      this.db,
    );
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.db.isOpen()) {
      this.initialized = true;
      return;
    }
    await ensureSchema(this.db);
    this.initialized = true;
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    const stores = this.db.tables.map((t) => t.name);
    return this.db.runTransaction('rw', stores, () => fn(createRepositoryScope(this.db)));
  }

  /** Commit wallet repository changes and outbox state in one IndexedDB transaction. */
  async withDurableEventOutboxTransaction<T>(
    fn: (scope: IdbDurableEventOutboxTransactionScope) => Promise<T>,
  ): Promise<T> {
    const stores = this.db.tables.map((table) => table.name);
    return this.db.runTransaction('rw', stores, (transaction) =>
      fn({
        ...createRepositoryScope(this.db),
        durableEventOutbox: new IdbDurableEventOutboxRepository(transaction),
      }),
    );
  }

  async configureDurableEventOutboxStorageLimits(limits: DurableEventStorageLimits): Promise<void> {
    return this.db.runTransaction('rw', [...IDB_DURABLE_EVENT_OUTBOX_STORES], (transaction) =>
      configureIdbDurableEventOutboxStorageLimits(transaction, limits),
    );
  }
}

export {
  IdbDb,
  ensureSchema,
  IdbMintRepository,
  IdbKeyRingRepository,
  IdbKeysetRepository,
  IdbCounterRepository,
  IdbProofRepository,
  IdbMeltQuoteRepository,
  IdbMintQuoteRepository,
  IdbLegacyMintQuoteRepository,
  IdbHistoryRepository,
  IdbSendOperationRepository,
  IdbMeltOperationRepository,
  IdbAuthSessionRepository,
  IdbMintOperationRepository,
  IdbReceiveOperationRepository,
  IdbPaymentRequestReceiveOperationRepository,
  IdbPaymentRequestReceiveAttemptRepository,
  IdbDurableEventOutboxRepository,
  IdbDurableEventOutboxTransactionPort,
  IDB_DURABLE_EVENT_OUTBOX_STORES,
};
export {
  configureIdbDurableEventOutboxStorageLimits,
  createIdbDurableEventStorageStats,
  validateIdbDurableEventStorageLimits,
} from './repositories/DurableEventOutboxRepository.ts';
