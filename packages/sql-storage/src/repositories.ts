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
} from '@cashu/coco-core/adapter';
import { RepositoryTransactionConflictError } from '@cashu/coco-core/adapter';
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
import { SqliteReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import {
  SqlitePaymentRequestReceiveAttemptRepository,
  SqlitePaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';

export interface SqlStorageRepositoriesOptions {
  database: SqlDatabase;
}

class RepositoryTransactionCallbackFailure extends Error {
  constructor(readonly error: unknown) {
    super('Repository transaction callback failed');
    this.name = 'RepositoryTransactionCallbackFailure';
    (this as unknown as { cause?: unknown }).cause = error;
  }
}

function getSqliteErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  if ('code' in error) return String((error as { code?: unknown }).code).toUpperCase();
  if ('errno' in error) return String((error as { errno?: unknown }).errno).toUpperCase();
  return '';
}

function hasSqliteTransactionConflictCode(error: unknown): boolean {
  const code = getSqliteErrorCode(error);
  return (
    code === '5' ||
    code === '6' ||
    code.startsWith('SQLITE_BUSY') ||
    code.startsWith('SQLITE_LOCKED')
  );
}

function isSqliteTransactionConflict(error: unknown): boolean {
  if (hasSqliteTransactionConflictCode(error)) return true;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('database table is locked') ||
    message.includes('database is busy')
  );
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
    receiveOperationRepository: new SqliteReceiveOperationRepository(database),
    paymentRequestReceiveOperationRepository: new SqlitePaymentRequestReceiveOperationRepository(
      database,
    ),
    paymentRequestReceiveAttemptRepository: new SqlitePaymentRequestReceiveAttemptRepository(
      database,
    ),
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
  readonly database: SqlDatabase;

  constructor(options: SqlStorageRepositoriesOptions) {
    this.database = options.database;
    const repositories = createRepositoryScope(this.database);
    this.mintRepository = repositories.mintRepository;
    this.keyRingRepository = new SqliteKeyRingRepository(this.database);
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
    try {
      return await this.database.transaction(
        async (txDatabase) => {
          try {
            return await fn(createRepositoryScope(txDatabase));
          } catch (error) {
            if (error instanceof RepositoryTransactionConflictError) throw error;
            if (hasSqliteTransactionConflictCode(error)) {
              throw new RepositoryTransactionConflictError(undefined, error);
            }
            throw new RepositoryTransactionCallbackFailure(error);
          }
        },
        { mode: 'immediate' },
      );
    } catch (error) {
      if (error instanceof RepositoryTransactionCallbackFailure) throw error.error;
      if (error instanceof RepositoryTransactionConflictError) throw error;
      if (isSqliteTransactionConflict(error)) {
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
};
