import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  MeltQuoteRepository,
  RepositoryTransactionScope,
} from 'coco-cashu-core';
import { IdbDb, type IdbDbOptions } from './lib/db.ts';
import { ensureSchema } from './lib/schema.ts';
import { IdbMintRepository } from './repositories/MintRepository.ts';
import { IdbKeysetRepository } from './repositories/KeysetRepository.ts';
import { IdbKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { IdbCounterRepository } from './repositories/CounterRepository.ts';
import { IdbProofRepository } from './repositories/ProofRepository.ts';
import { IdbMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { IdbMeltQuoteRepository } from './repositories/MeltQuoteRepository.ts';
import { IdbHistoryRepository } from './repositories/HistoryRepository.ts';

export interface IndexedDbRepositoriesOptions extends IdbDbOptions {}

export class IndexedDbRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly meltQuoteRepository: MeltQuoteRepository;
  readonly historyRepository: IdbHistoryRepository;
  readonly db: IdbDb;

  constructor(options: IndexedDbRepositoriesOptions) {
    this.db = new IdbDb(options);
    this.mintRepository = new IdbMintRepository(this.db);
    this.keyRingRepository = new IdbKeyRingRepository(this.db);
    this.counterRepository = new IdbCounterRepository(this.db);
    this.keysetRepository = new IdbKeysetRepository(this.db);
    this.proofRepository = new IdbProofRepository(this.db);
    this.mintQuoteRepository = new IdbMintQuoteRepository(this.db);
    this.meltQuoteRepository = new IdbMeltQuoteRepository(this.db);
    this.historyRepository = new IdbHistoryRepository(this.db);
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    const stores = this.db.tables.map((t) => t.name);
    return this.db.runTransaction('rw', stores, async () => {
      const scopedDb = this.db;
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new IdbMintRepository(scopedDb),
        keyRingRepository: new IdbKeyRingRepository(scopedDb),
        counterRepository: new IdbCounterRepository(scopedDb),
        keysetRepository: new IdbKeysetRepository(scopedDb),
        proofRepository: new IdbProofRepository(scopedDb),
        mintQuoteRepository: new IdbMintQuoteRepository(scopedDb),
        meltQuoteRepository: new IdbMeltQuoteRepository(scopedDb),
        historyRepository: new IdbHistoryRepository(scopedDb),
      };
      return fn(scopedRepositories);
    });
  }
}

export {
  IdbDb,
  ensureSchema,
  IdbMintRepository,
  IdbKeyRingRepository,
  IdbKeysetRepository,
  IdbCounterRepository,
  IdbProofRepository,
  IdbMintQuoteRepository,
  IdbMeltQuoteRepository,
  IdbHistoryRepository,
};
