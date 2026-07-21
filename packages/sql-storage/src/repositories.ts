import type {
  Repositories,
  RepositoryTransactionScope,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MeltQuoteRepository,
  MintQuoteRepository,
  LegacyMintQuoteRepository,
  HistoryProjectionRepository,
  SendOperationRepository,
  MeltOperationRepository,
  AuthSessionRepository,
  MintOperationRepository,
  MintIssuanceAttemptRepository,
  ReceiveOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from './index.ts';
import { ensureSchema } from './schema.ts';
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
import { SqliteMintIssuanceAttemptRepository } from './repositories/MintIssuanceAttemptRepository.ts';
import { SqliteReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import {
  SqlitePaymentRequestReceiveAttemptRepository,
  SqlitePaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';

export interface SqlStorageRepositoriesOptions {
  database: SqlDatabase;
}

function createRepositoryScope(database: SqlDatabase): RepositoryTransactionScope {
  return {
    mintRepository: new SqliteMintRepository(database),
    keyRingRepository: new SqliteKeyRingRepository(database),
    counterRepository: new SqliteCounterRepository(database),
    keysetRepository: new SqliteKeysetRepository(database),
    proofRepository: new SqliteProofRepository(database),
    meltQuoteRepository: new SqliteMeltQuoteRepository(database),
    mintQuoteRepository: new SqliteMintQuoteRepository(database),
    legacyMintQuoteRepository: new SqliteLegacyMintQuoteRepository(database),
    historyRepository: new SqliteHistoryRepository(database),
    sendOperationRepository: new SqliteSendOperationRepository(database),
    meltOperationRepository: new SqliteMeltOperationRepository(database),
    authSessionRepository: new SqliteAuthSessionRepository(database),
    mintOperationRepository: new SqliteMintOperationRepository(database),
    mintIssuanceAttemptRepository: new SqliteMintIssuanceAttemptRepository(database),
    receiveOperationRepository: new SqliteReceiveOperationRepository(database),
    paymentRequestReceiveOperationRepository: new SqlitePaymentRequestReceiveOperationRepository(
      database,
    ),
    paymentRequestReceiveAttemptRepository: new SqlitePaymentRequestReceiveAttemptRepository(
      database,
    ),
    withTransaction: (fn) =>
      database.transaction((transactionDatabase) => fn(createRepositoryScope(transactionDatabase))),
  };
}

export class SqlStorageRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly legacyMintQuoteRepository: LegacyMintQuoteRepository;
  readonly historyRepository: HistoryProjectionRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly authSessionRepository: AuthSessionRepository;
  readonly mintOperationRepository: MintOperationRepository;
  readonly mintIssuanceAttemptRepository: MintIssuanceAttemptRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly database: SqlDatabase;

  constructor(options: SqlStorageRepositoriesOptions) {
    this.database = options.database;
    const repositories = createRepositoryScope(this.database);
    this.mintRepository = repositories.mintRepository;
    this.keyRingRepository = repositories.keyRingRepository;
    this.counterRepository = repositories.counterRepository;
    this.keysetRepository = repositories.keysetRepository;
    this.proofRepository = repositories.proofRepository;
    this.meltQuoteRepository = repositories.meltQuoteRepository;
    this.mintQuoteRepository = repositories.mintQuoteRepository;
    this.legacyMintQuoteRepository = repositories.legacyMintQuoteRepository;
    this.historyRepository = repositories.historyRepository;
    this.sendOperationRepository = repositories.sendOperationRepository;
    this.meltOperationRepository = repositories.meltOperationRepository;
    this.authSessionRepository = repositories.authSessionRepository;
    this.mintOperationRepository = repositories.mintOperationRepository;
    this.mintIssuanceAttemptRepository = repositories.mintIssuanceAttemptRepository;
    this.receiveOperationRepository = repositories.receiveOperationRepository;
    this.paymentRequestReceiveOperationRepository =
      repositories.paymentRequestReceiveOperationRepository;
    this.paymentRequestReceiveAttemptRepository =
      repositories.paymentRequestReceiveAttemptRepository;
  }

  async init(): Promise<void> {
    await ensureSchema(this.database);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.database.transaction((txDatabase) => fn(createRepositoryScope(txDatabase)));
  }
}

export {
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
  SqliteMintIssuanceAttemptRepository,
  SqliteReceiveOperationRepository,
  SqlitePaymentRequestReceiveOperationRepository,
  SqlitePaymentRequestReceiveAttemptRepository,
};
