/// <reference types="bun" />

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { ensureSchemaUpTo, MIGRATIONS, type SqlDatabase } from '../index.ts';
import { createBunSqlDatabase } from './bunSqlDatabase.ts';

const EXPECTED_MIGRATION_IDS = [
  '001_initial',
  '002_melt_quotes',
  '003_history',
  '004_mint_trusted_field',
  '005_keyset_unit_field',
  '006_keypairs',
  '007_normalize_mint_urls',
  '008_send_operations',
  '009_history_send_operation',
  '010_rename_completed_to_finalized',
  '011_melt_operations',
  '012_send_operations_method',
  '013_receive_operations',
  '014_send_operations_token',
  '015_reset_keysets_for_string_denoms',
  '016_melt_settlement_amounts',
  '017_auth_sessions',
  '018_mint_operations',
  '019_mint_operations_pending_lifecycle',
  '020_mint_operations_failed_state',
  '021_melt_finalized_data',
  '022_melt_operation_unit',
  '023_receive_operation_unit',
  '024_amount_columns_text',
  '025_proof_unit',
  '026_send_operation_unit',
  '027_payment_request_receive',
  '028_history_projection_indexes',
  '029_backfill_send_operation_tokens',
  '030_method_aware_mint_quotes',
  '031_method_aware_melt_quotes',
  '032_onchain_melt_quotes',
  '032_mint_quote_method_data',
  '033_keypair_purpose',
  '034_clean_unquoted_mint_operations',
  '035_duplicate_quote_ids',
  '036_quote_identity_unique_indexes',
  '037_receive_operations_deferred',
] as const;

const RECEIVE_OPERATIONS_SQL = `
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
`;

async function getMigrationIds(db: SqlDatabase): Promise<string[]> {
  const rows = await db.all<{ id: string }>('SELECT id FROM coco_cashu_migrations ORDER BY id ASC');

  return rows.map((row) => row.id);
}

async function getColumnNames(db: SqlDatabase, tableName: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${tableName})`);

  return rows.map((row) => row.name);
}

async function getColumnTypes(db: SqlDatabase, tableName: string): Promise<Record<string, string>> {
  const rows = await db.all<{ name: string; type: string }>(`PRAGMA table_info(${tableName})`);

  return Object.fromEntries(rows.map((row) => [row.name, row.type]));
}

async function getIndexNames(db: SqlDatabase, tableName: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(`PRAGMA index_list(${tableName})`);

  return rows.map((row) => row.name);
}

async function insertMeltOperationRow(db: SqlDatabase, id: string, quoteId: string): Promise<void> {
  await db.run(
    `INSERT INTO coco_cashu_melt_operations
      (id, mintUrl, state, createdAt, updatedAt, method, methodDataJson, quoteId, unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'https://mint.test', 'init', 1, 1, 'bolt11', '{}', quoteId, 'sat'],
  );
}

const LEGACY_SEND_TOKEN = {
  mint: 'https://mint.test',
  proofs: [{ id: 'keyset-1', amount: '100', secret: 'send-secret', C: 'C_send' }],
  unit: 'sat',
};

async function seedSendOperationWithLegacyToken(db: SqlDatabase): Promise<void> {
  await db.run(
    `INSERT INTO coco_cashu_send_operations
      (id, mintUrl, amount, unit, state, createdAt, updatedAt, error, method, methodDataJson,
       needsSwap, fee, inputAmount, inputProofSecretsJson, outputDataJson, tokenJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'send-op-token-backfill',
      'https://mint.test',
      '100',
      'usd',
      'pending',
      2,
      3,
      null,
      'default',
      '{}',
      0,
      '0',
      '100',
      '["secret-1"]',
      null,
      null,
    ],
  );

  await db.run(
    `INSERT INTO coco_cashu_history
      (mintUrl, type, unit, amount, createdAt, state, tokenJson, operationId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'https://mint.test',
      'send',
      'sat',
      '100',
      1_000,
      'pending',
      JSON.stringify(LEGACY_SEND_TOKEN),
      'send-op-token-backfill',
    ],
  );
}

async function expectUniqueViolation(fn: () => Promise<void>): Promise<void> {
  let rejection: unknown;
  try {
    await fn();
  } catch (error) {
    rejection = error;
  }

  expect(String(rejection).toLowerCase()).toContain('unique');
}

function itWithDatabase(name: string, fn: (db: SqlDatabase) => Promise<void>): void {
  it(name, async () => {
    const database = new Database(':memory:');
    const db = createBunSqlDatabase(database);
    try {
      await fn(db);
    } finally {
      database.close();
    }
  });
}

describe('shared SQL schema migrations', () => {
  itWithDatabase('preserves the migration list and applies all migration ids', async (db) => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(EXPECTED_MIGRATION_IDS);

    await ensureSchemaUpTo(db);

    const ids = await getMigrationIds(db);
    expect(ids).toEqual(
      [...EXPECTED_MIGRATION_IDS, '012_receive_operations', '013_send_operations_method'].sort(),
    );
  });

  itWithDatabase('upgrades mint operations to allow failed state persistence', async (db) => {
    await ensureSchemaUpTo(db, '020_mint_operations_failed_state');

    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson, amount, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mint-op-1',
        'https://mint.test',
        'quote-1',
        'executing',
        1,
        2,
        null,
        'bolt11',
        '{}',
        100,
        JSON.stringify({ keep: [], send: [] }),
      ],
    );

    await ensureSchemaUpTo(db);

    await db.run(
      `UPDATE coco_cashu_mint_operations
       SET state = ?, error = ?, unit = ?, request = ?, expiry = ?
       WHERE id = ?`,
      ['failed', 'quote expired', 'sat', 'lnbc1test', 1_730_000_000, 'mint-op-1'],
    );

    const row = await db.get<{
      state: string;
      error: string;
      unit: string;
      request: string;
      expiry: number;
    }>(
      `SELECT state, error, unit, request, expiry
       FROM coco_cashu_mint_operations
       WHERE id = ?`,
      ['mint-op-1'],
    );

    expect(row).toEqual({
      state: 'failed',
      error: 'quote expired',
      unit: 'sat',
      request: 'lnbc1test',
      expiry: 1_730_000_000,
    });
  });

  itWithDatabase('accepts databases with old sqlite-bun swapped migration ids', async (db) => {
    await ensureSchemaUpTo(db, '012_send_operations_method');
    await db.exec(RECEIVE_OPERATIONS_SQL);
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN method TEXT NOT NULL DEFAULT 'default'`,
    );
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN methodDataJson TEXT NOT NULL DEFAULT '{}'`,
    );
    await db.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
      '012_receive_operations',
      1,
    ]);
    await db.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
      '013_send_operations_method',
      1,
    ]);

    await ensureSchemaUpTo(db);

    expect(await getMigrationIds(db)).toEqual(
      expect.arrayContaining([
        '012_send_operations_method',
        '013_send_operations_method',
        '012_receive_operations',
        '013_receive_operations',
      ]),
    );
  });

  itWithDatabase(
    'continues old sqlite-bun databases stopped after receive operations',
    async (db) => {
      await ensureSchemaUpTo(db, '012_send_operations_method');
      await db.exec(RECEIVE_OPERATIONS_SQL);
      await db.run('INSERT INTO coco_cashu_migrations (id, appliedAt) VALUES (?, ?)', [
        '012_receive_operations',
        1,
      ]);

      await ensureSchemaUpTo(db);

      expect(await getColumnNames(db, 'coco_cashu_send_operations')).toEqual(
        expect.arrayContaining(['method', 'methodDataJson', 'tokenJson']),
      );
      expect(await getColumnNames(db, 'coco_cashu_receive_operations')).toEqual(
        expect.arrayContaining(['unit']),
      );
      expect(await getMigrationIds(db)).toEqual(
        expect.arrayContaining([
          '012_send_operations_method',
          '013_send_operations_method',
          '012_receive_operations',
          '013_receive_operations',
        ]),
      );
    },
  );

  itWithDatabase('backfills legacy proof units from keyset metadata', async (db) => {
    await ensureSchemaUpTo(db, '025_proof_unit');
    await db.run(
      `INSERT INTO coco_cashu_keysets
        (mintUrl, id, keypairs, active, feePpk, updatedAt, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'usd-keyset', '{}', 1, 0, 1, 'USD'],
    );
    await db.run(
      `INSERT INTO coco_cashu_proofs
        (mintUrl, id, unit, amount, secret, C, state, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'usd-keyset', 'sat', '10', 'secret-usd', 'C-usd', 'ready', 1],
    );

    await ensureSchemaUpTo(db);

    const proof = await db.get<{ unit: string }>(
      'SELECT unit FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      ['https://mint.test', 'secret-usd'],
    );
    const indexes = await db.all<{ name: string }>('PRAGMA index_list(coco_cashu_proofs)');

    expect(proof?.unit).toBe('usd');
    expect(indexes.map((row) => row.name)).toContain('idx_coco_cashu_proofs_mint_unit_id_state');
  });

  itWithDatabase('keeps legacy proof units as sat when keyset metadata is missing', async (db) => {
    await ensureSchemaUpTo(db, '025_proof_unit');
    await db.run(
      `INSERT INTO coco_cashu_proofs
        (mintUrl, id, unit, amount, secret, C, state, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'missing-keyset', 'sat', '10', 'secret-legacy', 'C-legacy', 'ready', 1],
    );

    await ensureSchemaUpTo(db);

    const proof = await db.get<{ unit: string }>(
      'SELECT unit FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      ['https://mint.test', 'secret-legacy'],
    );

    expect(proof?.unit).toBe('sat');
  });

  itWithDatabase('backfills legacy aliases for canonical databases', async (db) => {
    await ensureSchemaUpTo(db);

    expect(await getMigrationIds(db)).toEqual(
      expect.arrayContaining([
        '012_send_operations_method',
        '013_send_operations_method',
        '012_receive_operations',
        '013_receive_operations',
      ]),
    );
  });

  itWithDatabase('adds only missing send method columns for partial schemas', async (db) => {
    await ensureSchemaUpTo(db, '012_send_operations_method');
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN method TEXT NOT NULL DEFAULT 'default'`,
    );

    await ensureSchemaUpTo(db);

    expect(await getColumnNames(db, 'coco_cashu_send_operations')).toEqual(
      expect.arrayContaining(['method', 'methodDataJson']),
    );
  });

  itWithDatabase('migrates legacy amount columns to text', async (db) => {
    await ensureSchemaUpTo(db, '024_amount_columns_text');

    await db.run(
      `INSERT INTO coco_cashu_proofs
        (mintUrl, id, unit, amount, secret, C, state, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'keyset-1', 'sat', 10, 'secret-amount', 'C-amount', 'ready', 1],
    );
    await db.run(
      `INSERT INTO coco_cashu_mint_quotes
        (mintUrl, quote, state, request, amount, unit, expiry, pubkey)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'mint-quote-amount', 'UNPAID', 'lnbc1mint', 21, 'sat', 100, null],
    );
    await db.run(
      `INSERT INTO coco_cashu_melt_quotes
        (mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['https://mint.test', 'melt-quote-amount', 'UNPAID', 'lnbc1melt', 22, 'sat', 100, 3, null],
    );
    await db.run(
      `INSERT INTO coco_cashu_history
        (mintUrl, type, unit, amount, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      ['https://mint.test', 'send', 'sat', 23, 1],
    );
    await db.run(
      `INSERT INTO coco_cashu_send_operations
        (id, mintUrl, amount, state, createdAt, updatedAt, error, needsSwap, fee,
         inputAmount, inputProofSecretsJson, outputDataJson, method, methodDataJson, tokenJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'send-op-amount',
        'https://mint.test',
        24,
        'pending',
        1,
        2,
        null,
        0,
        1,
        25,
        '[]',
        null,
        'default',
        '{}',
        null,
      ],
    );
    await db.run(
      `INSERT INTO coco_cashu_melt_operations
        (id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId,
         amount, fee_reserve, swap_fee, needsSwap, inputAmount, inputProofSecretsJson,
         changeOutputDataJson, swapOutputDataJson, changeAmount, effectiveFee,
         finalizedDataJson, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'melt-op-amount',
        'https://mint.test',
        'pending',
        1,
        2,
        null,
        'bolt11',
        '{}',
        'melt-op-quote-amount',
        26,
        4,
        1,
        0,
        27,
        '[]',
        null,
        null,
        2,
        3,
        null,
        'sat',
      ],
    );
    await db.run(
      `INSERT INTO coco_cashu_receive_operations
        (id, mintUrl, amount, state, createdAt, updatedAt, error, fee,
         inputProofsJson, outputDataJson, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['receive-op-amount', 'https://mint.test', 28, 'finalized', 1, 2, null, 1, '[]', null, 'sat'],
    );
    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson,
         amount, unit, request, expiry, pubkey, lastObservedRemoteState,
         lastObservedRemoteStateAt, terminalFailureJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mint-op-amount',
        'https://mint.test',
        'mint-op-quote-amount',
        'pending',
        1,
        2,
        null,
        'bolt11',
        '{}',
        29,
        'sat',
        'lnbc1mintop',
        100,
        null,
        'UNPAID',
        2_000,
        null,
        null,
      ],
    );

    await ensureSchemaUpTo(db);

    expect(await getColumnTypes(db, 'coco_cashu_proofs')).toMatchObject({ amount: 'TEXT' });
    expect(await getColumnTypes(db, 'coco_cashu_mint_quotes')).toMatchObject({ amount: 'TEXT' });
    expect(await getColumnTypes(db, 'coco_cashu_melt_quotes')).toMatchObject({
      amount: 'TEXT',
      fee_reserve: 'TEXT',
    });
    expect(await getColumnTypes(db, 'coco_cashu_send_operations')).toMatchObject({
      amount: 'TEXT',
      fee: 'TEXT',
      inputAmount: 'TEXT',
    });
    expect(await getColumnTypes(db, 'coco_cashu_melt_operations')).toMatchObject({
      amount: 'TEXT',
      fee_reserve: 'TEXT',
      swap_fee: 'TEXT',
      inputAmount: 'TEXT',
      changeAmount: 'TEXT',
      effectiveFee: 'TEXT',
    });
    expect(await getColumnTypes(db, 'coco_cashu_receive_operations')).toMatchObject({
      amount: 'TEXT',
      fee: 'TEXT',
    });
    expect(await getColumnTypes(db, 'coco_cashu_mint_operations')).toMatchObject({
      amount: 'TEXT',
    });

    const values = await db.get<{
      proofAmount: string;
      sendAmount: string;
      meltAmount: string;
      receiveAmount: string;
      mintAmount: string;
    }>(
      `SELECT
         (SELECT amount FROM coco_cashu_proofs WHERE secret = 'secret-amount') AS proofAmount,
         (SELECT amount FROM coco_cashu_send_operations WHERE id = 'send-op-amount') AS sendAmount,
         (SELECT amount FROM coco_cashu_melt_operations WHERE id = 'melt-op-amount') AS meltAmount,
         (SELECT amount FROM coco_cashu_receive_operations WHERE id = 'receive-op-amount') AS receiveAmount,
         (SELECT amount FROM coco_cashu_mint_operations WHERE id = 'mint-op-amount') AS mintAmount`,
    );

    expect(values).toEqual({
      proofAmount: '10',
      sendAmount: '24',
      meltAmount: '26',
      receiveAmount: '28',
      mintAmount: '29',
    });
  });

  itWithDatabase('creates indexes used by history projection queries', async (db) => {
    await ensureSchemaUpTo(db);

    expect(await getIndexNames(db, 'coco_cashu_send_operations')).toContain(
      'idx_coco_cashu_send_operations_createdAt',
    );
    expect(await getIndexNames(db, 'coco_cashu_melt_operations')).toContain(
      'idx_coco_cashu_melt_operations_createdAt',
    );
    expect(await getIndexNames(db, 'coco_cashu_mint_operations')).toContain(
      'idx_coco_cashu_mint_operations_createdAt',
    );
    expect(await getIndexNames(db, 'coco_cashu_receive_operations')).toContain(
      'idx_coco_cashu_receive_operations_createdAt',
    );
    expect(await getIndexNames(db, 'coco_cashu_history')).toEqual(
      expect.arrayContaining([
        'idx_coco_cashu_history_createdAt',
        'idx_coco_cashu_history_type_operation',
      ]),
    );
  });

  itWithDatabase(
    'backfills send operation tokens from matching legacy history rows',
    async (db) => {
      await ensureSchemaUpTo(db, '029_backfill_send_operation_tokens');
      await seedSendOperationWithLegacyToken(db);

      await ensureSchemaUpTo(db);

      const row = await db.get<{ tokenJson: string | null }>(
        `SELECT tokenJson FROM coco_cashu_send_operations WHERE id = ?`,
        ['send-op-token-backfill'],
      );
      expect(row?.tokenJson).toBe(JSON.stringify(LEGACY_SEND_TOKEN));

      const operation = await db.get<{ unit: string; tokenJson: string }>(
        `SELECT unit, tokenJson
       FROM coco_cashu_send_operations
       WHERE id = ?`,
        ['send-op-token-backfill'],
      );
      const token = JSON.parse(operation?.tokenJson ?? '{}') as typeof LEGACY_SEND_TOKEN;

      expect(operation?.unit).toBe('usd');
      expect(token).toEqual(LEGACY_SEND_TOKEN);
    },
  );

  itWithDatabase('backfills method-aware mint quotes from existing mint operations', async (db) => {
    await ensureSchemaUpTo(db, '030_method_aware_mint_quotes');

    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson,
         amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt,
         terminalFailureJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mint-op-finalized',
        'https://mint.test',
        'quote-finalized',
        'finalized',
        1,
        2,
        null,
        'bolt11',
        '{}',
        '21',
        'sat',
        'lnbc1finalized',
        1_730_000_000,
        null,
        'ISSUED',
        2_000,
        null,
        JSON.stringify({ keep: [], send: [] }),
      ],
    );

    await ensureSchemaUpTo(db);

    const row = await db.get<{
      method: string;
      quoteId: string;
      state: string;
      amount: string;
      reusable: number;
    }>(
      `SELECT method, quoteId, state, amount, reusable
       FROM coco_cashu_canonical_mint_quotes
       WHERE mintUrl = ? AND method = ? AND quoteId = ?`,
      ['https://mint.test', 'bolt11', 'quote-finalized'],
    );

    expect(row?.method).toBe('bolt11');
    expect(row?.quoteId).toBe('quote-finalized');
    expect(row?.state).toBe('ISSUED');
    expect(row?.amount).toBe('21');
    expect(row?.reusable).toBe(0);
  });

  itWithDatabase(
    'backfills method-aware melt quotes from legacy quotes and melt operations',
    async (db) => {
      await ensureSchemaUpTo(db, '031_method_aware_melt_quotes');

      await db.run(
        `INSERT INTO coco_cashu_melt_quotes
        (mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'https://mint.test',
          'legacy-melt-quote',
          'PENDING',
          'lnbc1legacy',
          '100',
          'sat',
          1_730_000_000,
          '2',
          null,
        ],
      );
      await db.run(
        `INSERT INTO coco_cashu_melt_operations
        (id, mintUrl, state, createdAt, updatedAt, error, method, methodDataJson, quoteId,
         amount, fee_reserve, unit, finalizedDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'melt-op-quote-backfill',
          'https://mint.test',
          'finalized',
          1,
          2,
          null,
          'bolt11',
          JSON.stringify({ invoice: 'lnbc1operation' }),
          'operation-melt-quote',
          '150',
          '3',
          'sat',
          JSON.stringify({ preimage: 'preimage-1' }),
        ],
      );

      await ensureSchemaUpTo(db);

      const rows = await db.all<{
        method: string;
        quoteId: string;
        state: string;
        request: string;
        amount: string;
        fee_reserve: string | null;
        payment_preimage: string | null;
      }>(
        `SELECT method, quoteId, state, request, amount, fee_reserve, payment_preimage
       FROM coco_cashu_melt_quotes
       WHERE mintUrl = ?
       ORDER BY quoteId ASC`,
        ['https://mint.test'],
      );

      expect(rows).toEqual([
        {
          method: 'bolt11',
          quoteId: 'legacy-melt-quote',
          state: 'PENDING',
          request: 'lnbc1legacy',
          amount: '100',
          fee_reserve: '2',
          payment_preimage: null,
        },
        {
          method: 'bolt11',
          quoteId: 'operation-melt-quote',
          state: 'PAID',
          request: 'lnbc1operation',
          amount: '150',
          fee_reserve: '3',
          payment_preimage: 'preimage-1',
        },
      ]);
    },
  );

  itWithDatabase('projects mint history remote state from canonical mint quotes', async (db) => {
    await ensureSchemaUpTo(db);

    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, error, method, methodDataJson,
         amount, unit, request, expiry, pubkey, lastObservedRemoteState, lastObservedRemoteStateAt,
         terminalFailureJson, outputDataJson)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'mint-op-remote-state',
        'https://mint.test',
        'quote-remote-state',
        'pending',
        1,
        2,
        null,
        'bolt11',
        '{}',
        '21',
        'sat',
        'lnbc1remote',
        1_730_000_000,
        null,
        'UNPAID',
        2_000,
        null,
        JSON.stringify({ keep: [], send: [] }),
      ],
    );
    await db.run(
      `INSERT INTO coco_cashu_canonical_mint_quotes
        (mintUrl, method, quoteId, state, request, amount, unit, quoteDataJson,
         lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'https://mint.test',
        'bolt11',
        'quote-remote-state',
        'PAID',
        'lnbc1remote',
        '21',
        'sat',
        JSON.stringify({ amount: '21' }),
        'PAID',
        3_000,
        0,
        1,
        2,
      ],
    );

    const projectionRow = await db.get<{
      operationId: string;
      quoteId: string;
      remoteState: string;
    }>(
      `SELECT
         op.id AS operationId,
         op.quoteId,
         q.lastObservedRemoteState AS remoteState
       FROM coco_cashu_mint_operations op
       LEFT JOIN coco_cashu_canonical_mint_quotes q
         ON q.mintUrl = op.mintUrl
        AND q.method = op.method
        AND q.quoteId = op.quoteId
       WHERE op.id = ?`,
      ['mint-op-remote-state'],
    );

    expect(projectionRow).toEqual({
      operationId: 'mint-op-remote-state',
      quoteId: 'quote-remote-state',
      remoteState: 'PAID',
    });
  });

  itWithDatabase('removes legacy mint operations without quote IDs', async (db) => {
    await ensureSchemaUpTo(db, '034_clean_unquoted_mint_operations');

    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, method, methodDataJson, amount, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['mint-op-quoted', 'https://mint.test', 'quote-1', 'init', 1, 2, 'bolt11', '{}', '21', 'sat'],
    );
    await db.run(
      `INSERT INTO coco_cashu_mint_operations
        (id, mintUrl, quoteId, state, createdAt, updatedAt, method, methodDataJson, amount, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['mint-op-unquoted', 'https://mint.test', null, 'init', 1, 2, 'bolt11', '{}', '21', 'sat'],
    );

    await ensureSchemaUpTo(db);

    const rows = await db.all<{ id: string }>(
      'SELECT id FROM coco_cashu_mint_operations ORDER BY id ASC',
    );

    expect(rows).toEqual([{ id: 'mint-op-quoted' }]);
  });

  itWithDatabase(
    'preserves quote-bound melt operation uniqueness after duplicate quote migration',
    async (db) => {
      await ensureSchemaUpTo(db);

      const indexes = await db.all<{ name: string; unique: number; partial: number }>(
        'PRAGMA index_list(coco_cashu_melt_operations)',
      );
      expect(indexes).toContainEqual(
        expect.objectContaining({
          name: 'ux_coco_cashu_melt_operations_mint_quote',
          unique: 1,
          partial: 1,
        }),
      );

      await insertMeltOperationRow(db, 'melt-op-1', 'shared-melt-quote');

      await expectUniqueViolation(async () => {
        await insertMeltOperationRow(db, 'melt-op-2', 'shared-melt-quote');
      });
    },
  );

  itWithDatabase(
    'enforces quote identity uniqueness across canonical quote methods',
    async (db) => {
      await ensureSchemaUpTo(db);

      await db.run(
        `INSERT INTO coco_cashu_canonical_mint_quotes
        (mintUrl, method, quoteId, state, request, amount, unit, quoteDataJson,
         lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'https://mint.test',
          'bolt11',
          'shared-mint-quote',
          'UNPAID',
          'lnbc1mint',
          '21',
          'sat',
          '{}',
          'UNPAID',
          1,
          0,
          1,
          1,
        ],
      );
      await expectUniqueViolation(async () => {
        await db.run(
          `INSERT INTO coco_cashu_canonical_mint_quotes
          (mintUrl, method, quoteId, state, request, amount, unit, quoteDataJson,
           lastObservedRemoteState, lastObservedRemoteStateAt, reusable, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'https://mint.test',
            'custom',
            'shared-mint-quote',
            'UNPAID',
            'custom-mint-request',
            '21',
            'sat',
            '{}',
            'UNPAID',
            1,
            0,
            1,
            1,
          ],
        );
      });

      await db.run(
        `INSERT INTO coco_cashu_melt_quotes
        (mintUrl, method, quoteId, state, request, amount, unit, expiry, fee_reserve,
         payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState,
         lastObservedRemoteStateAt, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'https://mint.test',
          'bolt11',
          'shared-melt-quote',
          'UNPAID',
          'lnbc1melt',
          '21',
          'sat',
          1_730_000_000,
          '1',
          null,
          null,
          null,
          null,
          'UNPAID',
          1,
          1,
          1,
        ],
      );
      await expectUniqueViolation(async () => {
        await db.run(
          `INSERT INTO coco_cashu_melt_quotes
          (mintUrl, method, quoteId, state, request, amount, unit, expiry, fee_reserve,
           payment_preimage, fee_options_json, outpoint, changeJson, lastObservedRemoteState,
           lastObservedRemoteStateAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'https://mint.test',
            'custom',
            'shared-melt-quote',
            'UNPAID',
            'custom-melt-request',
            '21',
            'sat',
            1_730_000_000,
            '1',
            null,
            null,
            null,
            null,
            'UNPAID',
            1,
            1,
            1,
          ],
        );
      });
    },
  );
});
