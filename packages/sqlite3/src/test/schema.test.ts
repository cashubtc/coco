import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Amount } from '@cashu/coco-core';
import { SqliteDb, SqliteHistoryRepository, ensureSchemaUpTo } from '../index.ts';

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

async function getMigrationIds(db: SqliteDb): Promise<string[]> {
  const rows = await db.all<{ id: string }>('SELECT id FROM coco_cashu_migrations ORDER BY id ASC');

  return rows.map((row) => row.id);
}

async function getColumnNames(db: SqliteDb, tableName: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${tableName})`);

  return rows.map((row) => row.name);
}

const LEGACY_SEND_TOKEN = {
  mint: 'https://mint.test',
  proofs: [{ id: 'keyset-1', amount: '100', secret: 'send-secret', C: 'C_send' }],
  unit: 'sat',
};

async function seedSendOperationWithLegacyToken(db: SqliteDb): Promise<void> {
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

describe('sqlite3 schema migrations', () => {
  let database: Database.Database;
  let db: SqliteDb;

  beforeEach(() => {
    database = new Database(':memory:');
    db = new SqliteDb({ database });
  });

  afterEach(async () => {
    await db.close();
  });

  it('accepts databases with old sqlite-bun swapped migration ids', async () => {
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

  it('continues old sqlite-bun databases stopped after receive operations', async () => {
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
  });

  it('backfills legacy proof units from keyset metadata', async () => {
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

  it('keeps legacy proof units as sat when keyset metadata is missing', async () => {
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

  it('backfills legacy aliases for canonical databases', async () => {
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

  it('adds only missing send method columns for partial schemas', async () => {
    await ensureSchemaUpTo(db, '012_send_operations_method');
    await db.run(
      `ALTER TABLE coco_cashu_send_operations ADD COLUMN method TEXT NOT NULL DEFAULT 'default'`,
    );

    await ensureSchemaUpTo(db);

    expect(await getColumnNames(db, 'coco_cashu_send_operations')).toEqual(
      expect.arrayContaining(['method', 'methodDataJson']),
    );
  });

  it('backfills send operation tokens from matching legacy history rows', async () => {
    await ensureSchemaUpTo(db, '029_backfill_send_operation_tokens');
    await seedSendOperationWithLegacyToken(db);

    await ensureSchemaUpTo(db);

    const row = await db.get<{ tokenJson: string | null }>(
      `SELECT tokenJson FROM coco_cashu_send_operations WHERE id = ?`,
      ['send-op-token-backfill'],
    );
    expect(row?.tokenJson).toBe(JSON.stringify(LEGACY_SEND_TOKEN));

    const repository = new SqliteHistoryRepository(db);
    const history = await repository.getPaginatedHistoryEntries(10, 0);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: 'send:send-op-token-backfill',
      source: 'operation',
      type: 'send',
      operationId: 'send-op-token-backfill',
      unit: 'usd',
      token: {
        mint: 'https://mint.test',
        unit: 'sat',
        proofs: [{ amount: Amount.from(100), secret: 'send-secret' }],
      },
    });
  });

  it('backfills method-aware mint quotes from existing mint operations', async () => {
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
});
