import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
} from 'coco-cashu-core';
import { IdbDb, type IdbDbOptions } from './lib/db.ts';
import { ensureSchema } from './lib/schema.ts';
import { IdbMintRepository } from './repositories/MintRepository.ts';
import { IdbKeysetRepository } from './repositories/KeysetRepository.ts';
import { IdbCounterRepository } from './repositories/CounterRepository.ts';
import { IdbProofRepository } from './repositories/ProofRepository.ts';
import { IdbMintQuoteRepository } from './repositories/MintQuoteRepository.ts';

export interface IndexedDbRepositoriesOptions extends IdbDbOptions {}

export class IndexedDbRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly db: IdbDb;

  constructor(options: IndexedDbRepositoriesOptions) {
    this.db = new IdbDb(options);
    this.mintRepository = new IdbMintRepository(this.db);
    this.counterRepository = new IdbCounterRepository(this.db);
    this.keysetRepository = new IdbKeysetRepository(this.db);
    this.proofRepository = new IdbProofRepository(this.db);
    this.mintQuoteRepository = new IdbMintQuoteRepository(this.db);
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }
}

export {
  IdbDb,
  ensureSchema,
  IdbMintRepository,
  IdbKeysetRepository,
  IdbCounterRepository,
  IdbProofRepository,
  IdbMintQuoteRepository,
};
