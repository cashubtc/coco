import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
} from 'coco-cashu-core';
import { ExpoSqliteDb, type ExpoSqliteDbOptions } from './db.ts';
import { ensureSchema } from './schema.ts';
import { ExpoMintRepository } from './repositories/MintRepository.ts';
import { ExpoKeysetRepository } from './repositories/KeysetRepository.ts';
import { ExpoCounterRepository } from './repositories/CounterRepository.ts';
import { ExpoProofRepository } from './repositories/ProofRepository.ts';
import { ExpoMintQuoteRepository } from './repositories/MintQuoteRepository.ts';

export interface ExpoSqliteRepositoriesOptions extends ExpoSqliteDbOptions {}

export class ExpoSqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly db: ExpoSqliteDb;

  constructor(options: ExpoSqliteRepositoriesOptions) {
    this.db = new ExpoSqliteDb(options);
    this.mintRepository = new ExpoMintRepository(this.db);
    this.counterRepository = new ExpoCounterRepository(this.db);
    this.keysetRepository = new ExpoKeysetRepository(this.db);
    this.proofRepository = new ExpoProofRepository(this.db);
    this.mintQuoteRepository = new ExpoMintQuoteRepository(this.db);
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
};
