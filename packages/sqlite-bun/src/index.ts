import type {
  InternalStorageAdapter,
  RepositorySet,
  RepositoryTransactionScope,
  StorageAccess,
} from 'coco-cashu-core/adapter';
import { createInternalStorageAdapter, STORAGE_ACCESS } from 'coco-cashu-core/adapter';
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
import { SqliteReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';

export interface SqliteStorageOptions extends SqliteDbOptions {}

export type SqliteRepositoriesOptions = SqliteStorageOptions;

function createRepositories(db: SqliteDb): RepositorySet {
  return {
    mintRepository: new SqliteMintRepository(db),
    keyRingRepository: new SqliteKeyRingRepository(db),
    counterRepository: new SqliteCounterRepository(db),
    keysetRepository: new SqliteKeysetRepository(db),
    proofRepository: new SqliteProofRepository(db),
    mintQuoteRepository: new SqliteMintQuoteRepository(db),
    meltQuoteRepository: new SqliteMeltQuoteRepository(db),
    historyRepository: new SqliteHistoryRepository(db),
    sendOperationRepository: new SqliteSendOperationRepository(db),
    meltOperationRepository: new SqliteMeltOperationRepository(db),
    receiveOperationRepository: new SqliteReceiveOperationRepository(db),
  };
}

export class SqliteStorage implements InternalStorageAdapter {
  readonly db: SqliteDb;
  readonly #adapter: InternalStorageAdapter;

  constructor(options: SqliteStorageOptions) {
    this.db = new SqliteDb(options);
    this.#adapter = createInternalStorageAdapter({
      init: async () => ensureSchema(this.db),
      repositories: createRepositories(this.db),
      withTransaction: async <T>(fn: (repos: RepositoryTransactionScope) => Promise<T>) => {
        return this.db.transaction(async (txDb) => fn(createRepositories(txDb)));
      },
    });
  }

  async init(): Promise<void> {
    await this.#adapter.init();
  }

  [STORAGE_ACCESS](): StorageAccess {
    return this.#adapter[STORAGE_ACCESS]();
  }
}

export { SqliteStorage as SqliteRepositories };

export { SqliteDb, ensureSchema, ensureSchemaUpTo, MIGRATIONS };

export type { Migration };
