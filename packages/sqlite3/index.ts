import { Database } from 'bun:sqlite';
import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  CounterRepository,
  ProofRepository,
} from '../core/repositories/index.ts';
import type { Proof } from '@cashu/cashu-ts';

type ProofState = 'inflight' | 'ready';

function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ensureSchema(database: Database): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS mints (
      mintUrl   TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      mintInfo  TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS keysets (
      mintUrl   TEXT NOT NULL,
      id        TEXT NOT NULL,
      keypairs  TEXT NOT NULL,
      active    INTEGER NOT NULL,
      feePpk    INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, id),
      FOREIGN KEY (mintUrl) REFERENCES mints(mintUrl) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS counters (
      mintUrl  TEXT NOT NULL,
      keysetId TEXT NOT NULL,
      counter  INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, keysetId),
      FOREIGN KEY (mintUrl) REFERENCES mints(mintUrl) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS proofs (
      mintUrl   TEXT NOT NULL,
      secret    TEXT NOT NULL,
      state     TEXT NOT NULL CHECK (state IN ('inflight', 'ready')),
      proofJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, secret),
      FOREIGN KEY (mintUrl) REFERENCES mints(mintUrl) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_proofs_state ON proofs(state);
    CREATE INDEX IF NOT EXISTS idx_proofs_mint_state ON proofs(mintUrl, state);
  `);
}

class SqliteMintRepository implements MintRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async isKnownMint(mintUrl: string): Promise<boolean> {
    const row = this.database
      .prepare('SELECT 1 AS x FROM mints WHERE mintUrl = ? LIMIT 1')
      .get(mintUrl) as { x: number } | undefined;
    return !!row;
  }

  async getMintByUrl(mintUrl: string) {
    const row = this.database
      .prepare(
        'SELECT mintUrl, name, mintInfo, createdAt, updatedAt FROM mints WHERE mintUrl = ? LIMIT 1',
      )
      .get(mintUrl) as
      | {
          mintUrl: string;
          name: string;
          mintInfo: string;
          createdAt: number;
          updatedAt: number;
        }
      | undefined;
    if (!row) {
      throw new Error(`Mint not found: ${mintUrl}`);
    }
    return {
      mintUrl: row.mintUrl,
      name: row.name,
      mintInfo: JSON.parse(row.mintInfo),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async getAllMints() {
    const rows = this.database
      .prepare('SELECT mintUrl, name, mintInfo, createdAt, updatedAt FROM mints')
      .all() as Array<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      createdAt: number;
      updatedAt: number;
    }>;
    return rows.map((r) => ({
      mintUrl: r.mintUrl,
      name: r.name,
      mintInfo: JSON.parse(r.mintInfo),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  async addNewMint(mint: {
    mintUrl: string;
    name: string;
    mintInfo: unknown;
    createdAt: number;
    updatedAt: number;
  }) {
    // Upsert without REPLACE (to preserve FKs)
    this.database
      .prepare(
        `INSERT INTO mints (mintUrl, name, mintInfo, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(mintUrl) DO UPDATE SET
           name=excluded.name,
           mintInfo=excluded.mintInfo,
           createdAt=excluded.createdAt,
           updatedAt=excluded.updatedAt`,
      )
      .run(mint.mintUrl, mint.name, JSON.stringify(mint.mintInfo), mint.createdAt, mint.updatedAt);
  }

  async updateMint(mint: {
    mintUrl: string;
    name: string;
    mintInfo: unknown;
    createdAt: number;
    updatedAt: number;
  }) {
    await this.addNewMint(mint);
  }

  async deleteMint(mintUrl: string) {
    this.database.prepare('DELETE FROM mints WHERE mintUrl = ?').run(mintUrl);
  }
}

class SqliteKeysetRepository implements KeysetRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async getKeysetsByMintUrl(mintUrl: string) {
    const rows = this.database
      .prepare(
        'SELECT mintUrl, id, keypairs, active, feePpk, updatedAt FROM keysets WHERE mintUrl = ?',
      )
      .all(mintUrl) as Array<{
      mintUrl: string;
      id: string;
      keypairs: string;
      active: number;
      feePpk: number;
      updatedAt: number;
    }>;
    return rows.map((r) => ({
      mintUrl: r.mintUrl,
      id: r.id,
      keypairs: JSON.parse(r.keypairs),
      active: !!r.active,
      feePpk: r.feePpk,
      updatedAt: r.updatedAt,
    }));
  }

  async getKeysetById(mintUrl: string, id: string) {
    const row = this.database
      .prepare(
        'SELECT mintUrl, id, keypairs, active, feePpk, updatedAt FROM keysets WHERE mintUrl = ? AND id = ? LIMIT 1',
      )
      .get(mintUrl, id) as
      | {
          mintUrl: string;
          id: string;
          keypairs: string;
          active: number;
          feePpk: number;
          updatedAt: number;
        }
      | undefined;
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      id: row.id,
      keypairs: JSON.parse(row.keypairs),
      active: !!row.active,
      feePpk: row.feePpk,
      updatedAt: row.updatedAt,
    };
  }

  async updateKeyset(keyset: { mintUrl: string; id: string; active: boolean; feePpk: number }) {
    const now = getUnixTimeSeconds();
    const existing = this.database
      .prepare('SELECT keypairs FROM keysets WHERE mintUrl = ? AND id = ? LIMIT 1')
      .get(keyset.mintUrl, keyset.id) as { keypairs: string } | undefined;

    if (!existing) {
      this.database
        .prepare(
          'INSERT INTO keysets (mintUrl, id, keypairs, active, feePpk, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          keyset.mintUrl,
          keyset.id,
          JSON.stringify({}),
          keyset.active ? 1 : 0,
          keyset.feePpk,
          now,
        );
      return;
    }

    this.database
      .prepare(
        'UPDATE keysets SET active = ?, feePpk = ?, updatedAt = ? WHERE mintUrl = ? AND id = ?',
      )
      .run(keyset.active ? 1 : 0, keyset.feePpk, now, keyset.mintUrl, keyset.id);
  }

  async addKeyset(keyset: {
    mintUrl: string;
    id: string;
    keypairs: Record<number, string>;
    active: boolean;
    feePpk: number;
  }) {
    const now = getUnixTimeSeconds();
    this.database
      .prepare(
        `INSERT INTO keysets (mintUrl, id, keypairs, active, feePpk, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(mintUrl, id) DO UPDATE SET
           keypairs=excluded.keypairs,
           active=excluded.active,
           feePpk=excluded.feePpk,
           updatedAt=excluded.updatedAt`,
      )
      .run(
        keyset.mintUrl,
        keyset.id,
        JSON.stringify(keyset.keypairs ?? {}),
        keyset.active ? 1 : 0,
        keyset.feePpk,
        now,
      );
  }

  async deleteKeyset(mintUrl: string, keysetId: string) {
    this.database
      .prepare('DELETE FROM keysets WHERE mintUrl = ? AND id = ?')
      .run(mintUrl, keysetId);
  }
}

class SqliteCounterRepository implements CounterRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async getCounter(mintUrl: string, keysetId: string) {
    const row = this.database
      .prepare('SELECT counter FROM counters WHERE mintUrl = ? AND keysetId = ? LIMIT 1')
      .get(mintUrl, keysetId) as { counter: number } | undefined;
    if (!row) return null;
    return { mintUrl, keysetId, counter: row.counter };
  }

  async setCounter(mintUrl: string, keysetId: string, counter: number) {
    this.database
      .prepare(
        `INSERT INTO counters (mintUrl, keysetId, counter)
         VALUES (?, ?, ?)
         ON CONFLICT(mintUrl, keysetId) DO UPDATE SET counter = excluded.counter`,
      )
      .run(mintUrl, keysetId, counter);
  }
}

class SqliteProofRepository implements ProofRepository {
  private readonly database: Database;

  constructor(database: Database) {
    this.database = database;
  }

  async saveProofs(mintUrl: string, proofs: Proof[]) {
    if (!proofs || proofs.length === 0) return;
    const now = getUnixTimeSeconds();
    this.database.exec('BEGIN');
    try {
      const selectOne = this.database.prepare(
        'SELECT 1 AS x FROM proofs WHERE mintUrl = ? AND secret = ? LIMIT 1',
      );
      for (const p of proofs) {
        const exists = selectOne.get(mintUrl, p.secret) as { x: number } | undefined;
        if (exists) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      const insert = this.database.prepare(
        `INSERT INTO proofs (mintUrl, secret, state, proofJson, createdAt)
         VALUES (?, ?, 'ready', ?, ?)`,
      );
      for (const p of proofs) insert.run(mintUrl, p.secret, JSON.stringify(p), now);
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
  }

  async getReadyProofs(mintUrl: string) {
    const rows = this.database
      .prepare('SELECT proofJson FROM proofs WHERE mintUrl = ? AND state = "ready"')
      .all(mintUrl) as Array<{ proofJson: string }>;
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl };
    });
  }

  async getAllReadyProofs() {
    const rows = this.database
      .prepare('SELECT proofJson, mintUrl FROM proofs WHERE state = "ready"')
      .all() as Array<{ proofJson: string; mintUrl: string }>;
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl: r.mintUrl };
    });
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState) {
    if (!secrets || secrets.length === 0) return;
    const update = this.database.prepare(
      'UPDATE proofs SET state = ? WHERE mintUrl = ? AND secret = ?',
    );
    this.database.exec('BEGIN');
    try {
      for (const s of secrets) {
        update.run(state, mintUrl, s);
      }
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
  }

  async deleteProofs(mintUrl: string, secrets: string[]) {
    if (!secrets || secrets.length === 0) return;
    const del = this.database.prepare('DELETE FROM proofs WHERE mintUrl = ? AND secret = ?');
    this.database.exec('BEGIN');
    try {
      for (const s of secrets) del.run(mintUrl, s);
      this.database.exec('COMMIT');
    } catch (err) {
      this.database.exec('ROLLBACK');
      throw err;
    }
  }
}

export interface SqliteRepositoriesOptions {
  filename?: string; // default ':memory:'
  database?: Database; // use an existing connection if provided
}

export class SqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly database: Database;

  constructor(options: SqliteRepositoriesOptions = {}) {
    this.database = options.database ?? new Database(options.filename ?? ':memory:');
    ensureSchema(this.database);
    this.mintRepository = new SqliteMintRepository(this.database);
    this.counterRepository = new SqliteCounterRepository(this.database);
    this.keysetRepository = new SqliteKeysetRepository(this.database);
    this.proofRepository = new SqliteProofRepository(this.database);
  }
}

export {
  SqliteMintRepository,
  SqliteKeysetRepository,
  SqliteCounterRepository,
  SqliteProofRepository,
};
