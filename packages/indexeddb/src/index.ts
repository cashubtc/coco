import type {
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
import { IdbDb, type IdbDbOptions, runOutsideIdbTransaction } from './lib/db.ts';
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
  readonly mintOperationRepository: MintOperationRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly db: IdbDb;
  private initialized = false;

  constructor(options: IndexedDbRepositoriesOptions) {
    this.db = new IdbDb(options);
    this.mintRepository = this.wrapRootRepository(new IdbMintRepository(this.db));
    this.keyRingRepository = this.wrapRootRepository(new IdbKeyRingRepository(this.db));
    this.counterRepository = this.wrapRootRepository(new IdbCounterRepository(this.db));
    this.keysetRepository = this.wrapRootRepository(new IdbKeysetRepository(this.db));
    this.proofRepository = this.wrapRootRepository(new IdbProofRepository(this.db));
    this.meltQuoteRepository = this.wrapRootRepository(new IdbMeltQuoteRepository(this.db));
    this.mintQuoteRepository = this.wrapRootRepository(new IdbMintQuoteRepository(this.db));
    this.legacyMintQuoteRepository = this.wrapRootRepository(
      new IdbLegacyMintQuoteRepository(this.db),
    );
    this.historyRepository = this.wrapRootRepository(new IdbHistoryRepository(this.db));
    this.sendOperationRepository = this.wrapRootRepository(new IdbSendOperationRepository(this.db));
    this.meltOperationRepository = this.wrapRootRepository(new IdbMeltOperationRepository(this.db));
    this.authSessionRepository = this.wrapRootRepository(new IdbAuthSessionRepository(this.db));
    this.mintOperationRepository = this.wrapRootRepository(new IdbMintOperationRepository(this.db));
    this.receiveOperationRepository = this.wrapRootRepository(
      new IdbReceiveOperationRepository(this.db),
    );
    this.paymentRequestReceiveOperationRepository = this.wrapRootRepository(
      new IdbPaymentRequestReceiveOperationRepository(this.db),
    );
    this.paymentRequestReceiveAttemptRepository = this.wrapRootRepository(
      new IdbPaymentRequestReceiveAttemptRepository(this.db),
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

  private wrapRootRepository<T extends object>(repository: T): T {
    return new Proxy(repository, {
      get: (target, property) => {
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) =>
          runOutsideIdbTransaction(() => Reflect.apply(value, target, args));
      },
    });
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
};
