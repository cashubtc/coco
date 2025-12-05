import { ExpoSqliteDb, getUnixTimeSeconds } from './db.ts';
import { normalizeMintUrl } from 'coco-cashu-core';

interface Migration {
  id: string;
  sql?: string;
  run?: (db: ExpoSqliteDb) => Promise<void>;
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
  {
    id: '007_normalize_mint_urls',
    run: async (db: ExpoSqliteDb) => {
      // Get all distinct mintUrls from the mints table
      const mints = await db.all<{ mintUrl: string }>('SELECT mintUrl FROM coco_cashu_mints');

      // Build mapping of old -> normalized URLs
      const urlMapping = new Map<string, string>();
      for (const { mintUrl } of mints) {
        const normalized = normalizeMintUrl(mintUrl);
        urlMapping.set(mintUrl, normalized);
      }

      // Check for conflicts: two different URLs normalizing to the same value
      const normalizedToOriginal = new Map<string, string>();
      for (const [original, normalized] of urlMapping) {
        const existing = normalizedToOriginal.get(normalized);
        if (existing && existing !== original) {
          throw new Error(
            `Mint URL normalization conflict: "${existing}" and "${original}" both normalize to "${normalized}". ` +
              `Please manually resolve this conflict before running the migration.`,
          );
        }
        normalizedToOriginal.set(normalized, original);
      }

      // Update all tables with normalized URLs
      const tables = [
        'coco_cashu_mints',
        'coco_cashu_keysets',
        'coco_cashu_counters',
        'coco_cashu_proofs',
        'coco_cashu_mint_quotes',
        'coco_cashu_melt_quotes',
        'coco_cashu_history',
      ];

      for (const [original, normalized] of urlMapping) {
        if (original === normalized) continue; // No change needed

        for (const table of tables) {
          await db.run(`UPDATE ${table} SET mintUrl = ? WHERE mintUrl = ?`, [normalized, original]);
        }
      }
    },
  },
  {
    id: '008_send_operations',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_send_operations (
        id         TEXT PRIMARY KEY NOT NULL,
        mintUrl    TEXT NOT NULL,
        amount     INTEGER NOT NULL,
        state      TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'pending', 'completed', 'rolling_back', 'rolled_back')),
        createdAt  INTEGER NOT NULL,
        updatedAt  INTEGER NOT NULL,
        error      TEXT,
        needsSwap  INTEGER,
        fee        INTEGER,
        inputAmount INTEGER,
        inputProofSecretsJson TEXT,
        outputDataJson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_state ON coco_cashu_send_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_mint ON coco_cashu_send_operations(mintUrl);

      ALTER TABLE coco_cashu_proofs ADD COLUMN usedByOperationId TEXT;
      ALTER TABLE coco_cashu_proofs ADD COLUMN createdByOperationId TEXT;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_usedByOp ON coco_cashu_proofs(usedByOperationId) WHERE usedByOperationId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_createdByOp ON coco_cashu_proofs(createdByOperationId) WHERE createdByOperationId IS NOT NULL;
    `,
  },
  {
    id: '009_history_send_operation',
    sql: `
      ALTER TABLE coco_cashu_history ADD COLUMN operationId TEXT;

      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_history_mint_operation_send
        ON coco_cashu_history(mintUrl, operationId)
        WHERE type = 'send' AND operationId IS NOT NULL;
    `,
  },
  {
    id: '010_rename_completed_to_finalized',
    run: async (db: ExpoSqliteDb) => {
      // Update send operations from 'completed' to 'finalized'
      await db.run(
        `UPDATE coco_cashu_send_operations SET state = 'finalized' WHERE state = 'completed'`,
      );

      // Update history entries from 'completed' to 'finalized' for send type
      await db.run(
        `UPDATE coco_cashu_history SET state = 'finalized' WHERE type = 'send' AND state = 'completed'`,
      );

      // Recreate send_operations table with updated CHECK constraint
      await db.exec(`
        CREATE TABLE coco_cashu_send_operations_new (
          id         TEXT PRIMARY KEY NOT NULL,
          mintUrl    TEXT NOT NULL,
          amount     INTEGER NOT NULL,
          state      TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')),
          createdAt  INTEGER NOT NULL,
          updatedAt  INTEGER NOT NULL,
          error      TEXT,
          needsSwap  INTEGER,
          fee        INTEGER,
          inputAmount INTEGER,
          inputProofSecretsJson TEXT,
          outputDataJson TEXT
        );

        INSERT INTO coco_cashu_send_operations_new SELECT * FROM coco_cashu_send_operations;

        DROP TABLE coco_cashu_send_operations;

        ALTER TABLE coco_cashu_send_operations_new RENAME TO coco_cashu_send_operations;

        CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_state ON coco_cashu_send_operations(state);
        CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_mint ON coco_cashu_send_operations(mintUrl);
      `);
    },
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
      if (migration.sql) {
        await tx.exec(migration.sql);
      }
      if (migration.run) {
        await migration.run(tx);
      }
      await tx.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
        migration.id,
        getUnixTimeSeconds(),
      ]);
    });
  }
}
