import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  MeltQuoteRepository,
  SendOperationRepository,
  MeltOperationRepository,
  RepositoryTransactionScope,
} from 'coco-cashu-core';
import { SqliteDb, type SqliteDbOptions } from './db.ts';
import { ensureSchema, ensureSchemaUpTo, MIGRATIONS, type Migration } from './schema.ts';
import { SqliteMintRepository } from './repositories/MintRepository.ts';
import { SqliteKeysetRepository } from './repositories/KeysetRepository.ts';
import { SqliteKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { SqliteCounterRepository } from './repositories/CounterRepository.ts';
import { SqliteProofRepository } from './repositories/ProofRepository.ts';
import { SqliteMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { SqliteMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { SqliteHistoryRepository } from './repositories/HistoryRepository.ts';
import { SqliteSendOperationRepository } from './repositories/SendOperationRepository.ts';
import { SqliteMeltOperationRepository } from './repositories/MeltOperationRepository.ts';

export interface SqliteRepositoriesOptions extends SqliteDbOptions {}

export class SqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly historyRepository: SqliteHistoryRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly db: SqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    this.db = new SqliteDb(options);
    this.mintRepository = new SqliteMintRepository(this.db);
    this.keyRingRepository = new SqliteKeyRingRepository(this.db);
    this.counterRepository = new SqliteCounterRepository(this.db);
    this.keysetRepository = new SqliteKeysetRepository(this.db);
    this.proofRepository = new SqliteProofRepository(this.db);
    this.mintQuoteRepository = new SqliteMintQuoteRepository(this.db);
    this.meltQuoteRepository = new SqliteMeltQuoteRepository(this.db);
    this.historyRepository = new SqliteHistoryRepository(this.db);
    this.sendOperationRepository = new SqliteSendOperationRepository(this.db);
    this.meltOperationRepository = new SqliteMeltOperationRepository(this.db);
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
        mintQuoteRepository: new SqliteMintQuoteRepository(txDb),
        meltQuoteRepository: new SqliteMeltQuoteRepository(txDb),
        historyRepository: new SqliteHistoryRepository(txDb),
        sendOperationRepository: new SqliteSendOperationRepository(txDb),
        meltOperationRepository: new SqliteMeltOperationRepository(txDb),
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
  SqliteMintQuoteRepository,
  SqliteMeltQuoteRepository,
  SqliteHistoryRepository,
  SqliteSendOperationRepository,
  SqliteMeltOperationRepository,
};

export type { Migration };
