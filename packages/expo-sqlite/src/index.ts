import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  MeltQuoteRepository,
} from 'coco-cashu-core';
import { ExpoSqliteDb, type ExpoSqliteDbOptions } from './db.ts';
import { ensureSchema } from './schema.ts';
import { ExpoMintRepository } from './repositories/MintRepository.ts';
import { ExpoKeysetRepository } from './repositories/KeysetRepository.ts';
import { ExpoCounterRepository } from './repositories/CounterRepository.ts';
import { ExpoProofRepository } from './repositories/ProofRepository.ts';
import { ExpoMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { ExpoMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { ExpoHistoryRepository } from './repositories/HistoryRepository.ts';

export interface ExpoSqliteRepositoriesOptions extends ExpoSqliteDbOptions {}

export class ExpoSqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly historyRepository: ExpoHistoryRepository;
  readonly db: ExpoSqliteDb;

  constructor(options: ExpoSqliteRepositoriesOptions) {
    this.db = new ExpoSqliteDb(options);
    this.mintRepository = new ExpoMintRepository(this.db);
    this.counterRepository = new ExpoCounterRepository(this.db);
    this.keysetRepository = new ExpoKeysetRepository(this.db);
    this.proofRepository = new ExpoProofRepository(this.db);
    this.mintQuoteRepository = new ExpoMintQuoteRepository(this.db);
    this.meltQuoteRepository = new ExpoMeltQuoteRepository(this.db);
    this.historyRepository = new ExpoHistoryRepository(this.db);
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }
}

export {
  ExpoSqliteDb,
  ensureSchema,
  ExpoMintRepository,
  ExpoKeysetRepository,
  ExpoCounterRepository,
  ExpoProofRepository,
  ExpoMintQuoteRepository,
  ExpoMeltQuoteRepository,
  ExpoHistoryRepository,
};
