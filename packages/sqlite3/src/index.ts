import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
} from './core.ts';
import { SqliteDb, type SqliteDbOptions } from './db.ts';
import { ensureSchema } from './schema.ts';
import { SqliteMintRepository } from './repositories/MintRepository.ts';
import { SqliteKeysetRepository } from './repositories/KeysetRepository.ts';
import { SqliteCounterRepository } from './repositories/CounterRepository.ts';
import { SqliteProofRepository } from './repositories/ProofRepository.ts';

export interface SqliteRepositoriesOptions extends SqliteDbOptions {}

export class SqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly db: SqliteDb;

  constructor(options: SqliteRepositoriesOptions) {
    this.db = new SqliteDb(options);
    // fire and forget is fine; but keep await for correctness
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    ensureSchema(this.db);
    this.mintRepository = new SqliteMintRepository(this.db);
    this.counterRepository = new SqliteCounterRepository(this.db);
    this.keysetRepository = new SqliteKeysetRepository(this.db);
    this.proofRepository = new SqliteProofRepository(this.db);
  }
}

export {
  SqliteDb,
  ensureSchema,
  SqliteMintRepository,
  SqliteKeysetRepository,
  SqliteCounterRepository,
  SqliteProofRepository,
};
