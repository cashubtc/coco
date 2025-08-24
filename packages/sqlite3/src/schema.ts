import { SqliteDb } from './db.ts';

export async function ensureSchema(db: SqliteDb): Promise<void> {
  await db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS coco_cashu_mints (
      mintUrl   TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      mintInfo  TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS coco_cashu_keysets (
      mintUrl   TEXT NOT NULL,
      id        TEXT NOT NULL,
      keypairs  TEXT NOT NULL,
      active    INTEGER NOT NULL,
      feePpk    INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, id),
      FOREIGN KEY (mintUrl) REFERENCES coco_cashu_mints(mintUrl) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS coco_cashu_counters (
      mintUrl  TEXT NOT NULL,
      keysetId TEXT NOT NULL,
      counter  INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, keysetId),
      FOREIGN KEY (mintUrl) REFERENCES coco_cashu_mints(mintUrl) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS coco_cashu_proofs (
      mintUrl   TEXT NOT NULL,
      secret    TEXT NOT NULL,
      state     TEXT NOT NULL CHECK (state IN ('inflight', 'ready')),
      proofJson TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      PRIMARY KEY (mintUrl, secret),
      FOREIGN KEY (mintUrl) REFERENCES coco_cashu_mints(mintUrl) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_state ON coco_cashu_proofs(state);
    CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_state ON coco_cashu_proofs(mintUrl, state);
  `);
}
