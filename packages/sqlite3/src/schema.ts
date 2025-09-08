import { SqliteDb, getUnixTimeSeconds } from './db.ts';

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_initial',
    sql: `
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
        PRIMARY KEY (mintUrl, id)
      );

      CREATE TABLE IF NOT EXISTS coco_cashu_counters (
        mintUrl  TEXT NOT NULL,
        keysetId TEXT NOT NULL,
        counter  INTEGER NOT NULL,
        PRIMARY KEY (mintUrl, keysetId)
      );

      CREATE TABLE IF NOT EXISTS coco_cashu_proofs (
        mintUrl   TEXT NOT NULL,
        id        TEXT NOT NULL,
        amount    INTEGER NOT NULL,
        secret    TEXT NOT NULL,
        C         TEXT NOT NULL,
        dleqJson  TEXT,
        witnessJson   TEXT,
        state     TEXT NOT NULL CHECK (state IN ('inflight', 'ready', 'spent')),
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (mintUrl, secret)
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_state ON coco_cashu_proofs(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_state ON coco_cashu_proofs(mintUrl, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_id_state ON coco_cashu_proofs(mintUrl, id, state);

      CREATE TABLE IF NOT EXISTS coco_cashu_mint_quotes (
        mintUrl TEXT NOT NULL,
        quote   TEXT NOT NULL,
        state   TEXT NOT NULL CHECK (state IN ('UNPAID','PAID','ISSUED')),
        request TEXT NOT NULL,
        amount  INTEGER NOT NULL,
        unit    TEXT NOT NULL,
        expiry  INTEGER NOT NULL,
        pubkey  TEXT,
        PRIMARY KEY (mintUrl, quote)
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_state ON coco_cashu_mint_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_mint ON coco_cashu_mint_quotes(mintUrl);
    `,
  },
  {
    id: '002_melt_quotes',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_melt_quotes (
        mintUrl TEXT NOT NULL,
        quote   TEXT NOT NULL,
        state   TEXT NOT NULL CHECK (state IN ('UNPAID','PENDING','PAID')),
        request TEXT NOT NULL,
        amount  INTEGER NOT NULL,
        unit    TEXT NOT NULL,
        expiry  INTEGER NOT NULL,
        fee_reserve INTEGER NOT NULL,
        payment_preimage TEXT,
        PRIMARY KEY (mintUrl, quote)
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_state ON coco_cashu_melt_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_mint ON coco_cashu_melt_quotes(mintUrl);
    `,
  },
];

export async function ensureSchema(db: SqliteDb): Promise<void> {
  // Ensure pragmas for current connection and create migrations tracking table
  await db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS coco_cashu_migrations (
      id        TEXT PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    );
  `);

  const appliedRows = await db.all<{ id: string }>(
    'SELECT id FROM coco_cashu_migrations ORDER BY id ASC',
  );
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
        migration.id,
        getUnixTimeSeconds(),
      ]);
    });
  }
}
