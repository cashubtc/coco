import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  MeltQuoteRepository,
  RepositoryTransactionScope,
} from 'coco-cashu-core';
import { SqliteDb, type SqliteDbOptions } from './db.ts';
import { ensureSchema } from './schema.ts';
import { SqliteMintRepository } from './repositories/MintRepository.ts';
import { SqliteKeysetRepository } from './repositories/KeysetRepository.ts';
import { SqliteCounterRepository } from './repositories/CounterRepository.ts';
import { SqliteProofRepository } from './repositories/ProofRepository.ts';
import { SqliteMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { SqliteMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { SqliteHistoryRepository } from './repositories/HistoryRepository.ts';

export interface SqliteRepositoriesOptions extends SqliteDbOptions {}

export class SqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly historyRepository: SqliteHistoryRepository;
  readonly db: SqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    this.db = new SqliteDb(options);
    this.mintRepository = new SqliteMintRepository(this.db);
    this.counterRepository = new SqliteCounterRepository(this.db);
    this.keysetRepository = new SqliteKeysetRepository(this.db);
    this.proofRepository = new SqliteProofRepository(this.db);
    this.mintQuoteRepository = new SqliteMintQuoteRepository(this.db);
    this.meltQuoteRepository = new SqliteMeltQuoteRepository(this.db);
    this.historyRepository = new SqliteHistoryRepository(this.db);
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new SqliteMintRepository(txDb),
        counterRepository: new SqliteCounterRepository(txDb),
        keysetRepository: new SqliteKeysetRepository(txDb),
        proofRepository: new SqliteProofRepository(txDb),
        mintQuoteRepository: new SqliteMintQuoteRepository(txDb),
        meltQuoteRepository: new SqliteMeltQuoteRepository(txDb),
        historyRepository: new SqliteHistoryRepository(txDb),
      };

      return fn(scopedRepositories);
    });
  }
}

export {
  SqliteDb,
  ensureSchema,
  SqliteMintRepository,
  SqliteKeysetRepository,
  SqliteCounterRepository,
  SqliteProofRepository,
  SqliteMintQuoteRepository,
  SqliteMeltQuoteRepository,
  SqliteHistoryRepository,
};
