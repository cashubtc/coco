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
  ReceiveOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  MintSwapPersistence,
} from '@cashu/coco-core/internal';
import { RepositoryTransactionConflictError } from '@cashu/coco-core/internal';
import { SqlTransactionConflictError } from './SqlTransactionConflictError.ts';
import type { SqlDatabase } from './index.ts';
import { ensureSchema } from './schema.ts';
import { sqlParameterLimit } from './utils.ts';
import { SqliteMintRepository } from './repositories/MintRepository.ts';
import {
  SqliteKeysetRepository,
  ScopedSqliteKeysetRepository,
} from './repositories/KeysetRepository.ts';
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
import { SqliteMintSwapOperationRepository } from './repositories/MintSwapOperationRepository.ts';

export interface SqlStorageRepositoriesOptions {
  database: SqlDatabase;
  mintSwap?: boolean;
}

function createRepositoryScope(
  database: SqlDatabase,
  mintSwapEnabled: boolean,
): RepositoryTransactionScope {
  return {
    mintRepository: new SqliteMintRepository(database),
    keyRingRepository: new SqliteKeyRingRepository(database),
    counterRepository: new SqliteCounterRepository(database),
    keysetRepository: new ScopedSqliteKeysetRepository(database),
    proofRepository: new SqliteProofRepository(database),
    meltQuoteRepository: new SqliteMeltQuoteRepository(database),
    mintQuoteRepository: new SqliteMintQuoteRepository(database),
    legacyMintQuoteRepository: new SqliteLegacyMintQuoteRepository(database),
    historyRepository: new SqliteHistoryRepository(database),
    sendOperationRepository: new SqliteSendOperationRepository(database),
    meltOperationRepository: new SqliteMeltOperationRepository(database),
    authSessionRepository: new SqliteAuthSessionRepository(database),
    mintOperationRepository: new SqliteMintOperationRepository(database),
    receiveOperationRepository: new SqliteReceiveOperationRepository(database),
    paymentRequestReceiveOperationRepository: new SqlitePaymentRequestReceiveOperationRepository(
      database,
    ),
    paymentRequestReceiveAttemptRepository: new SqlitePaymentRequestReceiveAttemptRepository(
      database,
    ),
    ...(mintSwapEnabled
      ? { mintSwap: { operationRepository: new SqliteMintSwapOperationRepository(database) } }
      : {}),
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
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly mintSwap?: MintSwapPersistence;
  private readonly database: SqlDatabase;
  private readonly mintSwapEnabled: boolean;

  constructor(options: SqlStorageRepositoriesOptions) {
    sqlParameterLimit(options.database);
    this.database = options.database;
    this.mintSwapEnabled = options.mintSwap ?? false;
    const repositories = createRepositoryScope(this.database, this.mintSwapEnabled);
    this.mintRepository = repositories.mintRepository;
    this.keyRingRepository = new SqliteKeyRingRepository(this.database);
    this.counterRepository = repositories.counterRepository;
    this.keysetRepository = new SqliteKeysetRepository(this.database);
    this.proofRepository = repositories.proofRepository;
    this.meltQuoteRepository = repositories.meltQuoteRepository;
    this.mintQuoteRepository = repositories.mintQuoteRepository;
    this.legacyMintQuoteRepository = repositories.legacyMintQuoteRepository;
    this.historyRepository = repositories.historyRepository;
    this.sendOperationRepository = repositories.sendOperationRepository;
    this.meltOperationRepository = repositories.meltOperationRepository;
    this.authSessionRepository = repositories.authSessionRepository;
    this.mintOperationRepository = repositories.mintOperationRepository;
    this.receiveOperationRepository = repositories.receiveOperationRepository;
    this.paymentRequestReceiveOperationRepository =
      repositories.paymentRequestReceiveOperationRepository;
    this.paymentRequestReceiveAttemptRepository =
      repositories.paymentRequestReceiveAttemptRepository;
    this.mintSwap = repositories.mintSwap;
  }

  async init(): Promise<void> {
    await ensureSchema(this.database);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    try {
      return await this.database.transaction(
        (txDatabase) => fn(createRepositoryScope(txDatabase, this.mintSwapEnabled)),
        { mode: 'immediate' },
      );
    } catch (error) {
      if (error instanceof RepositoryTransactionConflictError) throw error;
      if (error instanceof SqlTransactionConflictError) {
        throw new RepositoryTransactionConflictError(undefined, error);
      }
      throw error;
    }
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
  SqliteReceiveOperationRepository,
  SqlitePaymentRequestReceiveOperationRepository,
  SqlitePaymentRequestReceiveAttemptRepository,
  SqliteMintSwapOperationRepository,
};
