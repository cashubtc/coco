import { SqliteDb, getUnixTimeSeconds } from './db.ts';
import { normalizeMintUrl } from 'coco-cashu-core';

interface Migration {
  id: string;
  sql?: string;
  run?: (db: SqliteDb) => Promise<void>;
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
        publicKey TEXT PRIMARY KEY,
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
    run: async (db: SqliteDb) => {
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
        id         TEXT PRIMARY KEY,
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
    run: async (db: SqliteDb) => {
      // Update history entries from 'completed' to 'finalized' for send type
      // (history table has no CHECK constraint on state, so this is safe)
      await db.run(
        `UPDATE coco_cashu_history SET state = 'finalized' WHERE type = 'send' AND state = 'completed'`,
      );

      // Recreate send_operations table with updated CHECK constraint.
      // Transform 'completed' -> 'finalized' during INSERT to avoid CHECK constraint violation.
      // (Cannot UPDATE old table because old CHECK constraint doesn't allow 'finalized')
      await db.exec(`
        CREATE TABLE coco_cashu_send_operations_new (
          id         TEXT PRIMARY KEY,
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

        INSERT INTO coco_cashu_send_operations_new 
        SELECT 
          id, mintUrl, amount,
          CASE WHEN state = 'completed' THEN 'finalized' ELSE state END,
          createdAt, updatedAt, error, needsSwap, fee, inputAmount,
          inputProofSecretsJson, outputDataJson
        FROM coco_cashu_send_operations;

        DROP TABLE coco_cashu_send_operations;

        ALTER TABLE coco_cashu_send_operations_new RENAME TO coco_cashu_send_operations;

        CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_state ON coco_cashu_send_operations(state);
        CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_mint ON coco_cashu_send_operations(mintUrl);
      `);
    },
  },
  {
    id: '011_melt_operations',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_melt_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        quoteId TEXT,
        amount INTEGER,
        fee_reserve INTEGER,
        swap_fee INTEGER,
        needsSwap INTEGER,
        inputAmount INTEGER,
        inputProofSecretsJson TEXT,
        changeOutputDataJson TEXT,
        swapOutputDataJson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_operations_state
        ON coco_cashu_melt_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_operations_mint
        ON coco_cashu_melt_operations(mintUrl);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_melt_operations_mint_quote
        ON coco_cashu_melt_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `,
  },
  {
    id: '012_keypair_derivation_path',
    run: async (db: SqliteDb) => {
      // Add derivationPath column
      await db.exec('ALTER TABLE coco_cashu_keypairs ADD COLUMN derivationPath TEXT');

      // Backfill derivationPath for existing derived keys with the legacy coin type (129373)
      // We construct the path using string concatenation: 'm/129373\'/10\'/0\'/0\'/' || derivationIndex
      await db.exec(`
        UPDATE coco_cashu_keypairs 
        SET derivationPath = 'm/129373''/10''/0''/0''/' || derivationIndex 
        WHERE derivationIndex IS NOT NULL AND derivationPath IS NULL
      `);
    },
  },
];

// Export for testing
export { MIGRATIONS };
export type { Migration };

/**
 * Ensures the database schema is up to date by running all pending migrations.
 */
export async function ensureSchema(db: SqliteDb): Promise<void> {
  await ensureSchemaUpTo(db);
}

/**
 * Run migrations up to (but not including) a specific migration ID.
 * If stopBeforeId is not provided, runs all migrations.
 * Used for testing migration behavior.
 */
export async function ensureSchemaUpTo(db: SqliteDb, stopBeforeId?: string): Promise<void> {
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
    // Stop before the specified migration (for testing partial migrations)
    if (stopBeforeId && migration.id === stopBeforeId) break;

    if (applied.has(migration.id)) continue;
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
