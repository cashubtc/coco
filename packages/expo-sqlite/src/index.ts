import type { SQLiteDatabase } from 'expo-sqlite';
import type {
  DurableEventOutboxHostTransactionScope,
  DurableEventOutboxTransactionPort,
  DurableEventStorageLimits,
  Repositories,
  RepositoryTransactionScope,
} from '@cashu/coco-core/adapter';
import { SqlStorageRepositories } from '@cashu/coco-sql-storage';
import { ExpoSqliteDb } from './db.ts';

export interface SqliteRepositoriesOptions {
  database: SQLiteDatabase;
}

export type SqliteDurableEventOutboxTransactionScope =
  DurableEventOutboxHostTransactionScope<RepositoryTransactionScope>;

export class SqliteRepositories implements Repositories {
  readonly durableEventOutbox: DurableEventOutboxTransactionPort;
  readonly mintRepository: Repositories['mintRepository'];
  readonly keyRingRepository: Repositories['keyRingRepository'];
  readonly counterRepository: Repositories['counterRepository'];
  readonly keysetRepository: Repositories['keysetRepository'];
  readonly proofRepository: Repositories['proofRepository'];
  readonly meltQuoteRepository: Repositories['meltQuoteRepository'];
  readonly mintQuoteRepository: Repositories['mintQuoteRepository'];
  readonly legacyMintQuoteRepository: Repositories['legacyMintQuoteRepository'];
  readonly historyRepository: Repositories['historyRepository'];
  readonly sendOperationRepository: Repositories['sendOperationRepository'];
  readonly meltOperationRepository: Repositories['meltOperationRepository'];
  readonly authSessionRepository: Repositories['authSessionRepository'];
  readonly mintOperationRepository: Repositories['mintOperationRepository'];
  readonly receiveOperationRepository: Repositories['receiveOperationRepository'];
  readonly paymentRequestReceiveOperationRepository: Repositories['paymentRequestReceiveOperationRepository'];
  readonly paymentRequestReceiveAttemptRepository: Repositories['paymentRequestReceiveAttemptRepository'];
  private readonly db: ExpoSqliteDb;

  private readonly repositories: SqlStorageRepositories;

  constructor(options: SqliteRepositoriesOptions) {
    this.db = new ExpoSqliteDb(options);
    this.repositories = new SqlStorageRepositories({ database: this.db });
    this.durableEventOutbox = this.repositories.durableEventOutbox;
    this.mintRepository = this.repositories.mintRepository;
    this.keyRingRepository = this.repositories.keyRingRepository;
    this.counterRepository = this.repositories.counterRepository;
    this.keysetRepository = this.repositories.keysetRepository;
    this.proofRepository = this.repositories.proofRepository;
    this.meltQuoteRepository = this.repositories.meltQuoteRepository;
    this.mintQuoteRepository = this.repositories.mintQuoteRepository;
    this.legacyMintQuoteRepository = this.repositories.legacyMintQuoteRepository;
    this.historyRepository = this.repositories.historyRepository;
    this.sendOperationRepository = this.repositories.sendOperationRepository;
    this.meltOperationRepository = this.repositories.meltOperationRepository;
    this.authSessionRepository = this.repositories.authSessionRepository;
    this.mintOperationRepository = this.repositories.mintOperationRepository;
    this.receiveOperationRepository = this.repositories.receiveOperationRepository;
    this.paymentRequestReceiveOperationRepository =
      this.repositories.paymentRequestReceiveOperationRepository;
    this.paymentRequestReceiveAttemptRepository =
      this.repositories.paymentRequestReceiveAttemptRepository;
  }

  async init(): Promise<void> {
    await this.repositories.init();
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.repositories.withTransaction(fn);
  }

  /** Commit wallet repository changes and outbox state in one Expo SQLite transaction. */
  async withDurableEventOutboxTransaction<T>(
    fn: (scope: SqliteDurableEventOutboxTransactionScope) => Promise<T>,
  ): Promise<T> {
    return this.repositories.withDurableEventOutboxTransaction(fn);
  }

  async configureDurableEventOutboxStorageLimits(limits: DurableEventStorageLimits): Promise<void> {
    return this.repositories.configureDurableEventOutboxStorageLimits(limits);
  }
}

export type ExpoSqliteRepositoriesOptions = SqliteRepositoriesOptions;
export type ExpoSqliteDurableEventOutboxTransactionScope = SqliteDurableEventOutboxTransactionScope;
export { SqliteRepositories as ExpoSqliteRepositories };
