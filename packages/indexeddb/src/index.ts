import type {
  AuthSessionRepository,
  CounterRepository,
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
} from '@cashu/coco-core/adapter';
import { IdbDb, type IdbDbOptions } from './lib/db.ts';
import { ensureSchema } from './lib/schema.ts';
import { IdbAuthSessionRepository } from './repositories/AuthSessionRepository.ts';
import { IdbCounterRepository } from './repositories/CounterRepository.ts';
import { IdbHistoryRepository } from './repositories/HistoryRepository.ts';
import { IdbKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { IdbKeysetRepository } from './repositories/KeysetRepository.ts';
import { IdbLegacyMintQuoteRepository } from './repositories/LegacyMintQuoteRepository.ts';
import { IdbMeltOperationRepository } from './repositories/MeltOperationRepository.ts';
import { IdbMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { IdbMintOperationRepository } from './repositories/MintOperationRepository.ts';
import { IdbMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { IdbMintRecoveryRepository } from './repositories/MintRecoveryRepository.ts';
import { IdbMintRepository } from './repositories/MintRepository.ts';
import {
  IdbPaymentRequestReceiveAttemptRepository,
  IdbPaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';
import { IdbProofRepository } from './repositories/ProofRepository.ts';
import { IdbReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import { IdbSendOperationRepository } from './repositories/SendOperationRepository.ts';

export interface IndexedDbRepositoriesOptions extends IdbDbOptions {}

export class IndexedDbRepositories implements Repositories {
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
  readonly mintRecoveryRepository: MintRecoveryRepository;
  readonly mintOperationRepository: MintOperationRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly db: IdbDb;
  private initialized = false;

  constructor(options: IndexedDbRepositoriesOptions) {
    this.db = new IdbDb(options);
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
    this.mintRecoveryRepository = new IdbMintRecoveryRepository(this.db);
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
    if (this.db.hasAmbientTransaction) {
      throw new Error('Nested IndexedDB Wallet transactions are not supported');
    }

    const stores = this.db.tables.map((t) => t.name);
    return this.db.runTransaction('rw', stores, async () => {
      const scopedDb = this.db;
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new IdbMintRepository(scopedDb),
        keyRingRepository: new IdbKeyRingRepository(scopedDb),
        counterRepository: new IdbCounterRepository(scopedDb),
        keysetRepository: new IdbKeysetRepository(scopedDb),
        proofRepository: new IdbProofRepository(scopedDb),
        meltQuoteRepository: new IdbMeltQuoteRepository(scopedDb),
        mintQuoteRepository: new IdbMintQuoteRepository(scopedDb),
        legacyMintQuoteRepository: new IdbLegacyMintQuoteRepository(scopedDb),
        historyRepository: new IdbHistoryRepository(scopedDb),
        sendOperationRepository: new IdbSendOperationRepository(scopedDb),
        meltOperationRepository: new IdbMeltOperationRepository(scopedDb),
        authSessionRepository: new IdbAuthSessionRepository(scopedDb),
        mintRecoveryRepository: new IdbMintRecoveryRepository(scopedDb),
        mintOperationRepository: new IdbMintOperationRepository(scopedDb),
        receiveOperationRepository: new IdbReceiveOperationRepository(scopedDb),
        paymentRequestReceiveOperationRepository: new IdbPaymentRequestReceiveOperationRepository(
          scopedDb,
        ),
        paymentRequestReceiveAttemptRepository: new IdbPaymentRequestReceiveAttemptRepository(
          scopedDb,
        ),
      };
      return fn(scopedRepositories);
    });
  }
}

export {
  ensureSchema,
  IdbAuthSessionRepository,
  IdbCounterRepository,
  IdbDb,
  IdbHistoryRepository,
  IdbKeyRingRepository,
  IdbKeysetRepository,
  IdbLegacyMintQuoteRepository,
  IdbMeltOperationRepository,
  IdbMeltQuoteRepository,
  IdbMintOperationRepository,
  IdbMintQuoteRepository,
  IdbMintRepository,
  IdbPaymentRequestReceiveAttemptRepository,
  IdbPaymentRequestReceiveOperationRepository,
  IdbProofRepository,
  IdbReceiveOperationRepository,
  IdbSendOperationRepository,
};
