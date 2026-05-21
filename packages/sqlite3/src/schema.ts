import { SqliteDb, getUnixTimeSeconds } from './db.ts';
import { normalizeMintUrl } from '@cashu/coco-core';

interface Migration {
  id: string;
  sql?: string;
  run?: (db: SqliteDb) => Promise<void>;
}

type TableInfoRow = {
  name: string;
};

const SEND_OPERATION_METHOD_MIGRATION_IDS = [
  '012_send_operations_method',
  '013_send_operations_method',
] as const;

const RECEIVE_OPERATION_MIGRATION_IDS = [
  '013_receive_operations',
  '012_receive_operations',
] as const;

async function tableExists(db: SqliteDb, tableName: string): Promise<boolean> {
  const row = await db.get<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [tableName],
  );

  return !!row;
}

async function getTableColumns(db: SqliteDb, tableName: string): Promise<Set<string>> {
  const rows = await db.all<TableInfoRow>(`PRAGMA table_info(${tableName})`);
  return new Set(rows.map((row) => row.name));
}

async function insertMigrationIds(db: SqliteDb, ids: readonly string[]): Promise<void> {
  const appliedAt = getUnixTimeSeconds();

  for (const id of ids) {
    await db.run('INSERT OR IGNORE INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
      id,
      appliedAt,
    ]);
  }
}

async function addSendOperationMethodColumns(db: SqliteDb): Promise<void> {
  const columns = await getTableColumns(db, 'coco_cashu_send_operations');

  if (!columns.has('method')) {
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN method TEXT NOT NULL DEFAULT 'default'`,
    );
  }

  if (!columns.has('methodDataJson')) {
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN methodDataJson TEXT NOT NULL DEFAULT '{}'`,
    );
  }
}

async function addProofUnitColumn(db: SqliteDb): Promise<void> {
  const columns = await getTableColumns(db, 'coco_cashu_proofs');

  if (!columns.has('unit')) {
    await db.run(`ALTER TABLE coco_cashu_proofs ADD COLUMN unit TEXT NOT NULL DEFAULT 'sat'`);
  }

  await db.run(`
    UPDATE coco_cashu_proofs
    SET unit = COALESCE(
      (
        SELECT LOWER(TRIM(coco_cashu_keysets.unit))
        FROM coco_cashu_keysets
        WHERE coco_cashu_keysets.mintUrl = coco_cashu_proofs.mintUrl
          AND coco_cashu_keysets.id = coco_cashu_proofs.id
          AND coco_cashu_keysets.unit IS NOT NULL
          AND TRIM(coco_cashu_keysets.unit) <> ''
        LIMIT 1
      ),
      CASE
        WHEN unit IS NULL OR TRIM(unit) = '' THEN 'sat'
        ELSE LOWER(TRIM(unit))
      END
    )
  `);
  await db.run(
    'CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_state ON coco_cashu_proofs(mintUrl, unit, state)',
  );
  await db.run(
    'CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_id_state ON coco_cashu_proofs(mintUrl, unit, id, state)',
  );
  await db.run(
    'CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_unit_state ON coco_cashu_proofs(unit, state)',
  );
}

async function addSendOperationUnitColumn(db: SqliteDb): Promise<void> {
  const columns = await getTableColumns(db, 'coco_cashu_send_operations');

  if (!columns.has('unit')) {
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN unit TEXT NOT NULL DEFAULT 'sat'`,
    );
  }

  await db.run(
    "UPDATE coco_cashu_send_operations SET unit = 'sat' WHERE unit IS NULL OR TRIM(unit) = ''",
  );
  await db.run('UPDATE coco_cashu_send_operations SET unit = LOWER(TRIM(unit))');
}

async function backfillSendOperationTokensFromHistory(db: SqliteDb): Promise<void> {
  await db.run(`
    UPDATE coco_cashu_send_operations
    SET tokenJson = (
      SELECT h.tokenJson
      FROM coco_cashu_history h
      WHERE h.type = 'send'
        AND h.operationId = coco_cashu_send_operations.id
        AND h.mintUrl = coco_cashu_send_operations.mintUrl
        AND h.tokenJson IS NOT NULL
      ORDER BY h.createdAt DESC, h.id DESC
      LIMIT 1
    )
    WHERE tokenJson IS NULL
      AND EXISTS (
        SELECT 1
        FROM coco_cashu_history h
        WHERE h.type = 'send'
          AND h.operationId = coco_cashu_send_operations.id
          AND h.mintUrl = coco_cashu_send_operations.mintUrl
          AND h.tokenJson IS NOT NULL
      )
   `);
}

async function migrateAmountColumnsToText(db: SqliteDb): Promise<void> {
  if (await tableExists(db, 'coco_cashu_proofs')) {
    await db.exec(`
      ALTER TABLE coco_cashu_proofs RENAME TO coco_cashu_proofs_legacy_amounts;

      CREATE TABLE coco_cashu_proofs (
        mintUrl   TEXT NOT NULL,
        id        TEXT NOT NULL,
        unit      TEXT NOT NULL DEFAULT 'sat',
        amount    TEXT NOT NULL,
        secret    TEXT NOT NULL,
        C         TEXT NOT NULL,
        dleqJson  TEXT,
        witnessJson   TEXT,
        state     TEXT NOT NULL CHECK (state IN ('inflight', 'ready', 'spent')),
        createdAt INTEGER NOT NULL,
        usedByOperationId TEXT,
        createdByOperationId TEXT,
        PRIMARY KEY (mintUrl, secret)
      );

      INSERT INTO coco_cashu_proofs (
        mintUrl, id, unit, amount, secret, C, dleqJson, witnessJson, state, createdAt,
        usedByOperationId, createdByOperationId
      )
      SELECT
        mintUrl,
        id,
        COALESCE(
          (
            SELECT LOWER(TRIM(coco_cashu_keysets.unit))
            FROM coco_cashu_keysets
            WHERE coco_cashu_keysets.mintUrl = coco_cashu_proofs_legacy_amounts.mintUrl
              AND coco_cashu_keysets.id = coco_cashu_proofs_legacy_amounts.id
              AND coco_cashu_keysets.unit IS NOT NULL
              AND TRIM(coco_cashu_keysets.unit) <> ''
            LIMIT 1
          ),
          'sat'
        ),
        CAST(amount AS TEXT), secret, C, dleqJson, witnessJson, state, createdAt,
        usedByOperationId, createdByOperationId
      FROM coco_cashu_proofs_legacy_amounts;

      DROP TABLE coco_cashu_proofs_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_state ON coco_cashu_proofs(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_state ON coco_cashu_proofs(mintUrl, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_id_state ON coco_cashu_proofs(mintUrl, id, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_state ON coco_cashu_proofs(mintUrl, unit, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_id_state ON coco_cashu_proofs(mintUrl, unit, id, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_unit_state ON coco_cashu_proofs(unit, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_usedByOp ON coco_cashu_proofs(usedByOperationId) WHERE usedByOperationId IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_createdByOp ON coco_cashu_proofs(createdByOperationId) WHERE createdByOperationId IS NOT NULL;
    `);
  }

  if (await tableExists(db, 'coco_cashu_mint_quotes')) {
    await db.exec(`
      ALTER TABLE coco_cashu_mint_quotes RENAME TO coco_cashu_mint_quotes_legacy_amounts;

      CREATE TABLE coco_cashu_mint_quotes (
        mintUrl TEXT NOT NULL,
        quote   TEXT NOT NULL,
        state   TEXT NOT NULL CHECK (state IN ('UNPAID','PAID','ISSUED')),
        request TEXT NOT NULL,
        amount  TEXT NOT NULL,
        unit    TEXT NOT NULL,
        expiry  INTEGER,
        pubkey  TEXT,
        PRIMARY KEY (mintUrl, quote)
      );

      INSERT INTO coco_cashu_mint_quotes (
        mintUrl, quote, state, request, amount, unit, expiry, pubkey
      )
      SELECT mintUrl, quote, state, request, CAST(amount AS TEXT), unit, expiry, pubkey
      FROM coco_cashu_mint_quotes_legacy_amounts;

      DROP TABLE coco_cashu_mint_quotes_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_state ON coco_cashu_mint_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_mint ON coco_cashu_mint_quotes(mintUrl);
    `);
  }

  if (await tableExists(db, 'coco_cashu_melt_quotes')) {
    await db.exec(`
      ALTER TABLE coco_cashu_melt_quotes RENAME TO coco_cashu_melt_quotes_legacy_amounts;

      CREATE TABLE coco_cashu_melt_quotes (
        mintUrl TEXT NOT NULL,
        quote   TEXT NOT NULL,
        state   TEXT NOT NULL CHECK (state IN ('UNPAID','PENDING','PAID')),
        request TEXT NOT NULL,
        amount  TEXT NOT NULL,
        unit    TEXT NOT NULL,
        expiry  INTEGER NOT NULL,
        fee_reserve TEXT NOT NULL,
        payment_preimage TEXT,
        PRIMARY KEY (mintUrl, quote)
      );

      INSERT INTO coco_cashu_melt_quotes (
        mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage
      )
      SELECT
        mintUrl, quote, state, request, CAST(amount AS TEXT), unit, expiry,
        CAST(fee_reserve AS TEXT), payment_preimage
      FROM coco_cashu_melt_quotes_legacy_amounts;

      DROP TABLE coco_cashu_melt_quotes_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_state ON coco_cashu_melt_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_mint ON coco_cashu_melt_quotes(mintUrl);
    `);
  }

  if (await tableExists(db, 'coco_cashu_history')) {
    await db.exec(`
      ALTER TABLE coco_cashu_history RENAME TO coco_cashu_history_legacy_amounts;

      CREATE TABLE coco_cashu_history (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        mintUrl   TEXT NOT NULL,
        type      TEXT NOT NULL CHECK (type IN ('mint','melt','send','receive')),
        unit      TEXT NOT NULL,
        amount    TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        quoteId   TEXT,
        state     TEXT,
        paymentRequest TEXT,
        tokenJson TEXT,
        metadata  TEXT,
        operationId TEXT
      );

      INSERT INTO coco_cashu_history (
        id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest,
        tokenJson, metadata, operationId
      )
      SELECT
        id, mintUrl, type, unit, CAST(amount AS TEXT), createdAt, quoteId, state,
        paymentRequest, tokenJson, metadata, operationId
      FROM coco_cashu_history_legacy_amounts;

      DROP TABLE coco_cashu_history_legacy_amounts;

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
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_history_mint_operation_send
        ON coco_cashu_history(mintUrl, operationId)
        WHERE type = 'send' AND operationId IS NOT NULL;
    `);
  }

  if (await tableExists(db, 'coco_cashu_send_operations')) {
    await db.exec(`
      ALTER TABLE coco_cashu_send_operations RENAME TO coco_cashu_send_operations_legacy_amounts;

      CREATE TABLE coco_cashu_send_operations (
        id         TEXT PRIMARY KEY,
        mintUrl    TEXT NOT NULL,
        amount     TEXT NOT NULL,
        unit       TEXT NOT NULL DEFAULT 'sat',
        state      TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')),
        createdAt  INTEGER NOT NULL,
        updatedAt  INTEGER NOT NULL,
        error      TEXT,
        needsSwap  INTEGER,
        fee        TEXT,
        inputAmount TEXT,
        inputProofSecretsJson TEXT,
        outputDataJson TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        tokenJson TEXT
      );

      INSERT INTO coco_cashu_send_operations (
        id, mintUrl, amount, unit, state, createdAt, updatedAt, error, needsSwap, fee,
        inputAmount, inputProofSecretsJson, outputDataJson, method, methodDataJson, tokenJson
      )
      SELECT
        id, mintUrl, CAST(amount AS TEXT), 'sat', state, createdAt, updatedAt, error, needsSwap,
        CASE WHEN fee IS NULL THEN NULL ELSE CAST(fee AS TEXT) END,
        CASE WHEN inputAmount IS NULL THEN NULL ELSE CAST(inputAmount AS TEXT) END,
        inputProofSecretsJson, outputDataJson, method, methodDataJson, tokenJson
      FROM coco_cashu_send_operations_legacy_amounts;

      DROP TABLE coco_cashu_send_operations_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_state ON coco_cashu_send_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_mint ON coco_cashu_send_operations(mintUrl);
    `);
  }

  if (await tableExists(db, 'coco_cashu_melt_operations')) {
    await db.exec(`
      ALTER TABLE coco_cashu_melt_operations RENAME TO coco_cashu_melt_operations_legacy_amounts;

      CREATE TABLE coco_cashu_melt_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        quoteId TEXT,
        amount TEXT,
        fee_reserve TEXT,
        swap_fee TEXT,
        needsSwap INTEGER,
        inputAmount TEXT,
        inputProofSecretsJson TEXT,
        changeOutputDataJson TEXT,
        swapOutputDataJson TEXT,
        changeAmount TEXT,
        effectiveFee TEXT,
        finalizedDataJson TEXT,
        unit TEXT
      );

      INSERT INTO coco_cashu_melt_operations (
        id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId,
        amount, fee_reserve, swap_fee, needsSwap, inputAmount, inputProofSecretsJson,
        changeOutputDataJson, swapOutputDataJson, changeAmount, effectiveFee, finalizedDataJson, unit
      )
      SELECT
        id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId,
        CASE WHEN amount IS NULL THEN NULL ELSE CAST(amount AS TEXT) END,
        CASE WHEN fee_reserve IS NULL THEN NULL ELSE CAST(fee_reserve AS TEXT) END,
        CASE WHEN swap_fee IS NULL THEN NULL ELSE CAST(swap_fee AS TEXT) END,
        needsSwap,
        CASE WHEN inputAmount IS NULL THEN NULL ELSE CAST(inputAmount AS TEXT) END,
        inputProofSecretsJson, changeOutputDataJson, swapOutputDataJson,
        CASE WHEN changeAmount IS NULL THEN NULL ELSE CAST(changeAmount AS TEXT) END,
        CASE WHEN effectiveFee IS NULL THEN NULL ELSE CAST(effectiveFee AS TEXT) END,
        finalizedDataJson, unit
      FROM coco_cashu_melt_operations_legacy_amounts;

      DROP TABLE coco_cashu_melt_operations_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_operations_state
        ON coco_cashu_melt_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_operations_mint
        ON coco_cashu_melt_operations(mintUrl);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_melt_operations_mint_quote
        ON coco_cashu_melt_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `);
  }

  if (await tableExists(db, 'coco_cashu_receive_operations')) {
    await db.exec(`
      ALTER TABLE coco_cashu_receive_operations RENAME TO coco_cashu_receive_operations_legacy_amounts;

      CREATE TABLE coco_cashu_receive_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        amount TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'finalized', 'rolled_back')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        fee TEXT,
        inputProofsJson TEXT NOT NULL,
        outputDataJson TEXT,
        unit TEXT NOT NULL DEFAULT 'sat'
      );

      INSERT INTO coco_cashu_receive_operations (
        id, mintUrl, amount, state, createdAt, updatedAt, error, fee,
        inputProofsJson, outputDataJson, unit
      )
      SELECT
        id, mintUrl, CAST(amount AS TEXT), state, createdAt, updatedAt, error,
        CASE WHEN fee IS NULL THEN NULL ELSE CAST(fee AS TEXT) END,
        inputProofsJson, outputDataJson, unit
      FROM coco_cashu_receive_operations_legacy_amounts;

      DROP TABLE coco_cashu_receive_operations_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_receive_operations_state
        ON coco_cashu_receive_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_receive_operations_mint
        ON coco_cashu_receive_operations(mintUrl);
    `);
  }

  if (await tableExists(db, 'coco_cashu_mint_operations')) {
    await db.exec(`
      ALTER TABLE coco_cashu_mint_operations RENAME TO coco_cashu_mint_operations_legacy_amounts;

      CREATE TABLE coco_cashu_mint_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        quoteId TEXT,
        state TEXT NOT NULL CHECK (state IN ('init', 'pending', 'executing', 'finalized', 'failed')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        amount TEXT,
        unit TEXT,
        request TEXT,
        expiry INTEGER,
        pubkey TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        terminalFailureJson TEXT,
        outputDataJson TEXT
      );

      INSERT INTO coco_cashu_mint_operations (
        id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson,
        amount, unit, request, expiry, pubkey, lastObservedRemoteState,
        lastObservedRemoteStateAt, terminalFailureJson, outputDataJson
      )
      SELECT
        id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson,
        CASE WHEN amount IS NULL THEN NULL ELSE CAST(amount AS TEXT) END,
        unit, request, expiry, pubkey, lastObservedRemoteState,
        lastObservedRemoteStateAt, terminalFailureJson, outputDataJson
      FROM coco_cashu_mint_operations_legacy_amounts;

      DROP TABLE coco_cashu_mint_operations_legacy_amounts;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_state
        ON coco_cashu_mint_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint
        ON coco_cashu_mint_operations(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint_quote
        ON coco_cashu_mint_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `);
  }
}

async function reconcileMigrationAliases(db: SqliteDb): Promise<void> {
  if (await tableExists(db, 'coco_cashu_send_operations')) {
    const sendColumns = await getTableColumns(db, 'coco_cashu_send_operations');
    if (sendColumns.has('method') && sendColumns.has('methodDataJson')) {
      await insertMigrationIds(db, SEND_OPERATION_METHOD_MIGRATION_IDS);
    }
  }

  if (await tableExists(db, 'coco_cashu_receive_operations')) {
    await insertMigrationIds(db, RECEIVE_OPERATION_MIGRATION_IDS);
  }
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
        unit      TEXT NOT NULL DEFAULT 'sat',
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
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_state ON coco_cashu_proofs(mintUrl, unit, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_mint_unit_id_state ON coco_cashu_proofs(mintUrl, unit, id, state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_proofs_unit_state ON coco_cashu_proofs(unit, state);

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
    id: '012_send_operations_method',
    run: addSendOperationMethodColumns,
  },
  {
    id: '013_receive_operations',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_receive_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        amount INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('init', 'prepared', 'executing', 'finalized', 'rolled_back')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        fee INTEGER,
        inputProofsJson TEXT NOT NULL,
        outputDataJson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_receive_operations_state
        ON coco_cashu_receive_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_receive_operations_mint
        ON coco_cashu_receive_operations(mintUrl);
    `,
  },
  {
    id: '014_send_operations_token',
    sql: `
      ALTER TABLE coco_cashu_send_operations ADD COLUMN tokenJson TEXT;
    `,
  },
  {
    id: '015_reset_keysets_for_string_denoms',
    sql: `
      DELETE FROM coco_cashu_keysets;
      UPDATE coco_cashu_mints SET updatedAt = 0;
    `,
  },
  {
    id: '016_melt_settlement_amounts',
    sql: `
      ALTER TABLE coco_cashu_melt_operations ADD COLUMN changeAmount INTEGER;
      ALTER TABLE coco_cashu_melt_operations ADD COLUMN effectiveFee INTEGER;
    `,
  },
  {
    id: '017_auth_sessions',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_auth_sessions (
        mintUrl      TEXT PRIMARY KEY NOT NULL,
        accessToken  TEXT NOT NULL,
        refreshToken TEXT,
        expiresAt    INTEGER NOT NULL,
        scope        TEXT,
        batPoolJson  TEXT
      );
    `,
  },
  {
    id: '018_mint_operations',
    sql: `
      CREATE TABLE IF NOT EXISTS coco_cashu_mint_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        quoteId TEXT,
        state TEXT NOT NULL CHECK (state IN ('init', 'pending', 'executing', 'finalized', 'failed')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        amount INTEGER,
        unit TEXT,
        request TEXT,
        expiry INTEGER,
        pubkey TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        terminalFailureJson TEXT,
        outputDataJson TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_state
        ON coco_cashu_mint_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint
        ON coco_cashu_mint_operations(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint_quote
        ON coco_cashu_mint_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `,
  },
  {
    id: '019_mint_operations_pending_lifecycle',
    sql: `
      ALTER TABLE coco_cashu_mint_operations RENAME TO coco_cashu_mint_operations_legacy;

      CREATE TABLE coco_cashu_mint_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        quoteId TEXT,
        state TEXT NOT NULL CHECK (state IN ('init', 'pending', 'executing', 'finalized', 'failed')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        amount INTEGER,
        unit TEXT,
        request TEXT,
        expiry INTEGER,
        pubkey TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        terminalFailureJson TEXT,
        outputDataJson TEXT
      );

      INSERT INTO coco_cashu_mint_operations (
        id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt, terminalFailureJson, outputDataJson
      )
      SELECT
        id,
        mintUrl,
        quoteId,
        CASE
          WHEN state = 'prepared' THEN 'pending'
          WHEN state = 'rolled_back' THEN 'finalized'
          ELSE state
        END,
        createdAt,
        updatedAt,
        error,
        method,
        methodDataJson,
        amount,
        unit,
        request,
        expiry,
        pubkey,
        lastObservedRemoteState,
        lastObservedRemoteStateAt,
        terminalFailureJson,
        outputDataJson
      FROM coco_cashu_mint_operations_legacy;

      DROP TABLE coco_cashu_mint_operations_legacy;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_state
        ON coco_cashu_mint_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint
        ON coco_cashu_mint_operations(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint_quote
        ON coco_cashu_mint_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `,
  },
  {
    id: '020_mint_operations_failed_state',
    sql: `
      ALTER TABLE coco_cashu_mint_operations RENAME TO coco_cashu_mint_operations_legacy;

      CREATE TABLE coco_cashu_mint_operations (
        id TEXT PRIMARY KEY,
        mintUrl TEXT NOT NULL,
        quoteId TEXT,
        state TEXT NOT NULL CHECK (state IN ('init', 'pending', 'executing', 'finalized', 'failed')),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        method TEXT NOT NULL,
        methodDataJson TEXT NOT NULL,
        amount INTEGER,
        unit TEXT,
        request TEXT,
        expiry INTEGER,
        pubkey TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        terminalFailureJson TEXT,
        outputDataJson TEXT
      );

      INSERT INTO coco_cashu_mint_operations (
        id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt, terminalFailureJson, outputDataJson
      )
      SELECT
        id,
        mintUrl,
        quoteId,
        state,
        createdAt,
        updatedAt,
        error,
        method,
        methodDataJson,
        amount,
        unit,
        request,
        expiry,
        pubkey,
        lastObservedRemoteState,
        lastObservedRemoteStateAt,
        terminalFailureJson,
        outputDataJson
      FROM coco_cashu_mint_operations_legacy;

      DROP TABLE coco_cashu_mint_operations_legacy;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_state
        ON coco_cashu_mint_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint
        ON coco_cashu_mint_operations(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint_quote
        ON coco_cashu_mint_operations(mintUrl, quoteId)
        WHERE quoteId IS NOT NULL;
    `,
  },
  {
    id: '021_melt_finalized_data',
    sql: `
      ALTER TABLE coco_cashu_melt_operations ADD COLUMN finalizedDataJson TEXT;
    `,
  },
  {
    id: '022_melt_operation_unit',
    sql: `
      ALTER TABLE coco_cashu_melt_operations ADD COLUMN unit TEXT;
    `,
  },
  {
    id: '023_receive_operation_unit',
    sql: `
      ALTER TABLE coco_cashu_receive_operations ADD COLUMN unit TEXT NOT NULL DEFAULT 'sat';
    `,
  },
  {
    id: '024_amount_columns_text',
    run: migrateAmountColumnsToText,
  },
  {
    id: '025_proof_unit',
    run: addProofUnitColumn,
  },
  {
    id: '026_send_operation_unit',
    run: addSendOperationUnitColumn,
  },
  {
    id: '027_payment_request_receive',
    sql: `
      ALTER TABLE coco_cashu_receive_operations ADD COLUMN sourceJson TEXT;

      CREATE TABLE IF NOT EXISTS coco_cashu_payment_request_receive_operations (
        id TEXT PRIMARY KEY,
        requestId TEXT,
        encodedRequest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'completed', 'cancelled')),
        transport TEXT NOT NULL CHECK (transport IN ('inband', 'nostr', 'post')),
        amount TEXT NOT NULL,
        unit TEXT NOT NULL,
        mintsJson TEXT NOT NULL,
        singleUse INTEGER NOT NULL,
        description TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        error TEXT,
        completedAt INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_pr_receive_operations_state
        ON coco_cashu_payment_request_receive_operations(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_pr_receive_operations_request_id
        ON coco_cashu_payment_request_receive_operations(requestId);

      CREATE TABLE IF NOT EXISTS coco_cashu_payment_request_receive_attempts (
        id TEXT PRIMARY KEY,
        requestOperationId TEXT NOT NULL,
        requestId TEXT,
        transport TEXT NOT NULL CHECK (transport IN ('inband', 'nostr', 'post')),
        transportMessageId TEXT,
        payloadHash TEXT NOT NULL,
        senderPubkey TEXT,
        memo TEXT,
        mintUrl TEXT NOT NULL,
        unit TEXT NOT NULL,
        grossAmount TEXT NOT NULL,
        fee TEXT,
        netAmount TEXT,
        receiveOperationId TEXT,
        state TEXT NOT NULL CHECK (state IN ('received', 'validating', 'receiving', 'finalized', 'rejected')),
        error TEXT,
        payloadJson TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_pr_receive_attempts_request_operation
        ON coco_cashu_payment_request_receive_attempts(requestOperationId);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_pr_receive_attempts_state
        ON coco_cashu_payment_request_receive_attempts(state);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_pr_receive_attempts_message
        ON coco_cashu_payment_request_receive_attempts(transportMessageId)
        WHERE transportMessageId IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_pr_receive_attempts_payload
        ON coco_cashu_payment_request_receive_attempts(requestOperationId, payloadHash);
      CREATE UNIQUE INDEX IF NOT EXISTS ux_coco_cashu_pr_receive_attempts_receive
        ON coco_cashu_payment_request_receive_attempts(receiveOperationId)
        WHERE receiveOperationId IS NOT NULL;
    `,
  },
  {
    id: '028_history_projection_indexes',
    sql: `
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_send_operations_createdAt
        ON coco_cashu_send_operations(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_operations_createdAt
        ON coco_cashu_melt_operations(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_createdAt
        ON coco_cashu_mint_operations(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_receive_operations_createdAt
        ON coco_cashu_receive_operations(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_history_createdAt
        ON coco_cashu_history(createdAt DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_history_type_operation
        ON coco_cashu_history(type, operationId)
        WHERE operationId IS NOT NULL;
    `,
  },
  {
    id: '029_backfill_send_operation_tokens',
    run: backfillSendOperationTokensFromHistory,
  },
  {
    id: '030_method_aware_mint_quotes',
    sql: `
      ALTER TABLE coco_cashu_mint_quotes RENAME TO coco_cashu_mint_quotes_legacy;

      CREATE TABLE coco_cashu_mint_quotes (
        mintUrl TEXT NOT NULL,
        method TEXT NOT NULL,
        quoteId TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('UNPAID','PAID','ISSUED')),
        request TEXT NOT NULL,
        amount TEXT NOT NULL,
        unit TEXT NOT NULL,
        expiry INTEGER,
        pubkey TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        reusable INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (mintUrl, method, quoteId)
      );

      INSERT INTO coco_cashu_mint_quotes (
        mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
        lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt
      )
      SELECT
        mintUrl,
        'bolt11',
        quote,
        state,
        request,
        amount,
        unit,
        expiry,
        pubkey,
        state,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        0,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM coco_cashu_mint_quotes_legacy;

      INSERT INTO coco_cashu_mint_quotes (
        mintUrl, method, quoteId, state, request, amount, unit, expiry, pubkey,
        lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt
      )
      SELECT
        mintUrl,
        method,
        quoteId,
        CASE
          WHEN lastObservedRemoteState IN ('UNPAID','PAID','ISSUED') THEN lastObservedRemoteState
          WHEN state = 'finalized' THEN 'ISSUED'
          ELSE 'UNPAID'
        END,
        request,
        amount,
        unit,
        expiry,
        pubkey,
        CASE
          WHEN lastObservedRemoteState IN ('UNPAID','PAID','ISSUED') THEN lastObservedRemoteState
          WHEN state = 'finalized' THEN 'ISSUED'
          ELSE 'UNPAID'
        END,
        COALESCE(lastObservedRemoteStateAt, updatedAt * 1000),
        0,
        createdAt * 1000,
        updatedAt * 1000
      FROM coco_cashu_mint_operations
      WHERE quoteId IS NOT NULL
        AND request IS NOT NULL
        AND amount IS NOT NULL
        AND unit IS NOT NULL
      ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
        state = excluded.state,
        request = excluded.request,
        amount = excluded.amount,
        unit = excluded.unit,
        expiry = excluded.expiry,
        pubkey = excluded.pubkey,
        lastObservedRemoteState = excluded.lastObservedRemoteState,
        lastObservedRemoteStateAt = excluded.lastObservedRemoteStateAt,
        updatedAt = excluded.updatedAt;

      DROP TABLE coco_cashu_mint_quotes_legacy;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_state
        ON coco_cashu_mint_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_mint
        ON coco_cashu_mint_quotes(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_quotes_method
        ON coco_cashu_mint_quotes(method);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_mint_operations_mint_method_quote
        ON coco_cashu_mint_operations(mintUrl, method, quoteId)
        WHERE quoteId IS NOT NULL;
    `,
  },
  {
    id: '031_method_aware_melt_quotes',
    sql: `
      ALTER TABLE coco_cashu_melt_quotes RENAME TO coco_cashu_melt_quotes_legacy;

      CREATE TABLE coco_cashu_melt_quotes (
        mintUrl TEXT NOT NULL,
        method TEXT NOT NULL,
        quoteId TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('UNPAID','PENDING','PAID')),
        request TEXT NOT NULL,
        amount TEXT NOT NULL,
        unit TEXT NOT NULL,
        expiry INTEGER NOT NULL,
        fee_reserve TEXT NOT NULL,
        payment_preimage TEXT,
        changeJson TEXT,
        lastObservedRemoteState TEXT,
        lastObservedRemoteStateAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY (mintUrl, method, quoteId)
      );

      INSERT INTO coco_cashu_melt_quotes (
        mintUrl, method, quoteId, state, request, amount, unit, expiry, fee_reserve,
        payment_preimage, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
        createdAt, updatedAt
      )
      SELECT
        mintUrl,
        'bolt11',
        quote,
        state,
        request,
        amount,
        unit,
        expiry,
        fee_reserve,
        payment_preimage,
        NULL,
        state,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      FROM coco_cashu_melt_quotes_legacy;

      INSERT INTO coco_cashu_melt_quotes (
        mintUrl, method, quoteId, state, request, amount, unit, expiry, fee_reserve,
        payment_preimage, changeJson, lastObservedRemoteState, lastObservedRemoteStateAt,
        createdAt, updatedAt
      )
      SELECT
        mintUrl,
        method,
        quoteId,
        CASE
          WHEN state = 'finalized' THEN 'PAID'
          WHEN state IN ('pending','executing') THEN 'PENDING'
          ELSE 'UNPAID'
        END,
        COALESCE(json_extract(methodDataJson, '$.invoice'), quoteId),
        amount,
        unit,
        0,
        fee_reserve,
        json_extract(finalizedDataJson, '$.preimage'),
        NULL,
        CASE
          WHEN state = 'finalized' THEN 'PAID'
          WHEN state IN ('pending','executing') THEN 'PENDING'
          ELSE 'UNPAID'
        END,
        updatedAt * 1000,
        createdAt * 1000,
        updatedAt * 1000
      FROM coco_cashu_melt_operations
      WHERE quoteId IS NOT NULL
        AND amount IS NOT NULL
        AND fee_reserve IS NOT NULL
        AND unit IS NOT NULL
      ON CONFLICT(mintUrl, method, quoteId) DO UPDATE SET
        state = excluded.state,
        request = excluded.request,
        amount = excluded.amount,
        unit = excluded.unit,
        fee_reserve = excluded.fee_reserve,
        payment_preimage = excluded.payment_preimage,
        lastObservedRemoteState = excluded.lastObservedRemoteState,
        lastObservedRemoteStateAt = excluded.lastObservedRemoteStateAt,
        updatedAt = excluded.updatedAt;

      DROP TABLE coco_cashu_melt_quotes_legacy;

      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_state
        ON coco_cashu_melt_quotes(state);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_mint
        ON coco_cashu_melt_quotes(mintUrl);
      CREATE INDEX IF NOT EXISTS idx_coco_cashu_melt_quotes_method
        ON coco_cashu_melt_quotes(method);
    `,
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

  await reconcileMigrationAliases(db);

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

  await reconcileMigrationAliases(db);
}
