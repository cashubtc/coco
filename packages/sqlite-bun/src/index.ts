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
} from '@cashu/coco-core';
import { SqliteDb, type SqliteDbOptions } from './db.ts';
import { ensureSchema, ensureSchemaUpTo, MIGRATIONS, type Migration } from './schema.ts';
import { SqliteMintRepository } from './repositories/MintRepository.ts';
import { SqliteKeysetRepository } from './repositories/KeysetRepository.ts';
import { SqliteKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { SqliteCounterRepository } from './repositories/CounterRepository.ts';
import { SqliteProofRepository } from './repositories/ProofRepository.ts';
import { SqliteMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { SqliteMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { SqliteLegacyMintQuoteRepository } from './repositories/LegacyMintQuoteRepository.ts';
import { SqliteHistoryRepository } from './repositories/HistoryRepository.ts';
import { SqliteSendOperationRepository } from './repositories/SendOperationRepository.ts';
import { SqliteMeltOperationRepository } from './repositories/MeltOperationRepository.ts';
import { SqliteAuthSessionRepository } from './repositories/AuthSessionRepository.ts';
import { SqliteMintOperationRepository } from './repositories/MintOperationRepository.ts';
import { SqliteReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import {
  SqlitePaymentRequestReceiveAttemptRepository,
  SqlitePaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';

export interface SqliteRepositoriesOptions extends SqliteDbOptions {}

export class SqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly legacyMintQuoteRepository: LegacyMintQuoteRepository;
  readonly historyRepository: SqliteHistoryRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly authSessionRepository: AuthSessionRepository;
  readonly mintOperationRepository: MintOperationRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly db: SqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    this.db = new SqliteDb(options);
    this.mintRepository = new SqliteMintRepository(this.db);
    this.keyRingRepository = new SqliteKeyRingRepository(this.db);
    this.counterRepository = new SqliteCounterRepository(this.db);
    this.keysetRepository = new SqliteKeysetRepository(this.db);
    this.proofRepository = new SqliteProofRepository(this.db);
    this.meltQuoteRepository = new SqliteMeltQuoteRepository(this.db);
    this.mintQuoteRepository = new SqliteMintQuoteRepository(this.db);
    this.legacyMintQuoteRepository = new SqliteLegacyMintQuoteRepository(this.db);
    this.historyRepository = new SqliteHistoryRepository(this.db);
    this.sendOperationRepository = new SqliteSendOperationRepository(this.db);
    this.meltOperationRepository = new SqliteMeltOperationRepository(this.db);
    this.authSessionRepository = new SqliteAuthSessionRepository(this.db);
    this.mintOperationRepository = new SqliteMintOperationRepository(this.db);
    this.receiveOperationRepository = new SqliteReceiveOperationRepository(this.db);
    this.paymentRequestReceiveOperationRepository =
      new SqlitePaymentRequestReceiveOperationRepository(this.db);
    this.paymentRequestReceiveAttemptRepository = new SqlitePaymentRequestReceiveAttemptRepository(
      this.db,
    );
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new SqliteMintRepository(txDb),
        keyRingRepository: new SqliteKeyRingRepository(txDb),
        counterRepository: new SqliteCounterRepository(txDb),
        keysetRepository: new SqliteKeysetRepository(txDb),
        proofRepository: new SqliteProofRepository(txDb),
        meltQuoteRepository: new SqliteMeltQuoteRepository(txDb),
        mintQuoteRepository: new SqliteMintQuoteRepository(txDb),
        legacyMintQuoteRepository: new SqliteLegacyMintQuoteRepository(txDb),
        historyRepository: new SqliteHistoryRepository(txDb),
        sendOperationRepository: new SqliteSendOperationRepository(txDb),
        meltOperationRepository: new SqliteMeltOperationRepository(txDb),
        authSessionRepository: new SqliteAuthSessionRepository(txDb),
        mintOperationRepository: new SqliteMintOperationRepository(txDb),
        receiveOperationRepository: new SqliteReceiveOperationRepository(txDb),
        paymentRequestReceiveOperationRepository:
          new SqlitePaymentRequestReceiveOperationRepository(txDb),
        paymentRequestReceiveAttemptRepository: new SqlitePaymentRequestReceiveAttemptRepository(
          txDb,
        ),
      };

      return fn(scopedRepositories);
    });
  }
}

export {
  SqliteDb,
  ensureSchema,
  ensureSchemaUpTo,
  MIGRATIONS,
  SqliteMintRepository,
  SqliteKeyRingRepository,
  SqliteKeysetRepository,
  SqliteCounterRepository,
  SqliteProofRepository,
  SqliteMeltQuoteRepository,
  SqliteMintQuoteRepository,
  SqliteLegacyMintQuoteRepository,
  SqliteHistoryRepository,
  SqliteSendOperationRepository,
  SqliteMeltOperationRepository,
  SqliteAuthSessionRepository,
  SqliteMintOperationRepository,
  SqliteReceiveOperationRepository,
  SqlitePaymentRequestReceiveOperationRepository,
  SqlitePaymentRequestReceiveAttemptRepository,
};

export type { Migration };
