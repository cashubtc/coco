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
import { ExpoSqliteDb, type ExpoSqliteDbOptions } from './db.ts';
import { ensureSchema, ensureSchemaUpTo, MIGRATIONS, type Migration } from './schema.ts';
import { ExpoMintRepository } from './repositories/MintRepository.ts';
import { ExpoKeysetRepository } from './repositories/KeysetRepository.ts';
import { ExpoKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { ExpoCounterRepository } from './repositories/CounterRepository.ts';
import { ExpoProofRepository } from './repositories/ProofRepository.ts';
import { ExpoMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { ExpoMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { ExpoHistoryRepository } from './repositories/HistoryRepository.ts';
import { ExpoSendOperationRepository } from './repositories/SendOperationRepository.ts';
import { ExpoMeltOperationRepository } from './repositories/MeltOperationRepository.ts';

export interface ExpoSqliteRepositoriesOptions extends ExpoSqliteDbOptions {}

export class ExpoSqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly historyRepository: ExpoHistoryRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly db: ExpoSqliteDb;

  constructor(options: ExpoSqliteRepositoriesOptions) {
    this.db = new ExpoSqliteDb(options);
    this.mintRepository = new ExpoMintRepository(this.db);
    this.keyRingRepository = new ExpoKeyRingRepository(this.db);
    this.counterRepository = new ExpoCounterRepository(this.db);
    this.keysetRepository = new ExpoKeysetRepository(this.db);
    this.proofRepository = new ExpoProofRepository(this.db);
    this.mintQuoteRepository = new ExpoMintQuoteRepository(this.db);
    this.meltQuoteRepository = new ExpoMeltQuoteRepository(this.db);
    this.historyRepository = new ExpoHistoryRepository(this.db);
    this.sendOperationRepository = new ExpoSendOperationRepository(this.db);
    this.meltOperationRepository = new ExpoMeltOperationRepository(this.db);
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new ExpoMintRepository(txDb),
        keyRingRepository: new ExpoKeyRingRepository(txDb),
        counterRepository: new ExpoCounterRepository(txDb),
        keysetRepository: new ExpoKeysetRepository(txDb),
        proofRepository: new ExpoProofRepository(txDb),
        mintQuoteRepository: new ExpoMintQuoteRepository(txDb),
        meltQuoteRepository: new ExpoMeltQuoteRepository(txDb),
        historyRepository: new ExpoHistoryRepository(txDb),
        sendOperationRepository: new ExpoSendOperationRepository(txDb),
        meltOperationRepository: new ExpoMeltOperationRepository(txDb),
      };

      return fn(scopedRepositories);
    });
  }
}

export {
  ExpoSqliteDb,
  ensureSchema,
  ensureSchemaUpTo,
  MIGRATIONS,
  ExpoMintRepository,
  ExpoKeyRingRepository,
  ExpoKeysetRepository,
  ExpoCounterRepository,
  ExpoProofRepository,
  ExpoMintQuoteRepository,
  ExpoMeltQuoteRepository,
  ExpoHistoryRepository,
  ExpoSendOperationRepository,
  ExpoMeltOperationRepository,
};

export type { Migration };
