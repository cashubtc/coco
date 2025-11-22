import { ExpoSqliteDb, getUnixTimeSeconds } from './db.ts';

interface Migration {
  id: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_mints (
        mintUrl   TEXT PRIMARY KEY NOT NULL,
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
  {
    id: '003_history',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        mintUrl   TEXT NOT NULL,
        type      TEXT NOT NULL CHECK (type IN ('mint','melt','send','receive')),
        unit      TEXT NOT NULL,
        amount    INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        quoteId   TEXT,
        state     TEXT,
        paymentRequest TEXT,
        tokenJson TEXT,
        metadata  TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_history_mint_createdAt
        ON coco_cashu_history(mintUrl, createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_history_mint_quote
        ON coco_cashu_history(mintUrl, quoteId);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_history_type
        ON coco_cashu_history(type);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_history_mint_quote_mint
        ON coco_cashu_history(mintUrl, quoteId, type)
        WHERE type = 'mint' AND quoteId IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_history_mint_quote_melt
        ON coco_cashu_history(mintUrl, quoteId, type)
        WHERE type = 'melt' AND quoteId IS NOT NULL;
    `,
  },
  {
    id: '004_mint_trusted_field',
    sql: `
      ALTER TABLE coco_cashu_mints ADD COLUMN trusted INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    id: '005_keyset_unit_field',
    sql: `
      ALTER TABLE coco_cashu_keysets ADD COLUMN unit TEXT;
    `,
  },
  {
    id: '006_keypairs',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_keypairs (
        publicKey TEXT PRIMARY KEY NOT NULL,
        secretKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        derivationIndex INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_keypairs_createdAt ON coco_cashu_keypairs(createdAt DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_keypairs_derivationIndex ON coco_cashu_keypairs(derivationIndex DESC) WHERE derivationIndex IS NOT NULL;
    `,
  },
];

export async function ensureSchema(db: ExpoSqliteDb): Promise<void> {
  // Create migrations tracking table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS coco_cashu_migrations (
      id        TEXT PRIMARY KEY NOT NULL,
      appliedAt INTEGER NOT NULL
    );
  `);

  const appliedRows = await db.all<{ id: string }>(
    'SELECT id FROM coco_cashu_migrations ORDER BY id ASC',
  );
  const applied = new Set(appliedRows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // A single transaction is implied by ExpoSqliteDb.transaction
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
        migration.id,
        getUnixTimeSeconds(),
      ]);
    });
  }
}
