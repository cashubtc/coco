/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import { ExpoSqliteDb, ensureSchemaUpTo } from '../index.ts';
import type { ExpoSqliteDbOptions } from '../db.ts';

type RunResult = { changes: number; lastInsertRowId: number; lastInsertRowid: number };

class BunExpoSqliteDatabaseShim {
  private readonly db: Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
  }

  async execAsync(sql: string): Promise<void> {
    const statements = sql
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statementSql of statements) {
      this.db.prepare(statementSql).run();
    }
  }

  async runAsync(sql: string, ...params: any[]): Promise<RunResult> {
    const result = this.db.prepare(sql).run(...params) as unknown as {
      changes?: number;
      lastInsertRowid?: number;
    };

    const changes = Number(result?.changes ?? 0);
    const lastInsertRowId = Number(result?.lastInsertRowid ?? 0);
    return { changes, lastInsertRowId, lastInsertRowid: lastInsertRowId };
  }

  async getFirstAsync<T = unknown>(sql: string, ...params: any[]): Promise<T | null> {
    const row = this.db.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async getAllAsync<T = unknown>(sql: string, ...params: any[]): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...params) as T[] | undefined;
    return rows ?? [];
  }

  async closeAsync(): Promise<void> {
    this.db.close();
  }
}

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

async function getMigrationIds(db: ExpoSqliteDb): Promise<string[]> {
  const rows = await db.all<{ id: string }>('SELECT id FROM coco_cashu_migrations ORDER BY id ASC');

  return rows.map((row) => row.id);
}

async function getColumnNames(db: ExpoSqliteDb, tableName: string): Promise<string[]> {
  const rows = await db.all<{ name: string }>(`PRAGMA table_info(${tableName})`);

  return rows.map((row) => row.name);
}

describe('expo-sqlite schema migrations', () => {
  let database: BunExpoSqliteDatabaseShim;
  let db: ExpoSqliteDb;

  beforeEach(() => {
    database = new BunExpoSqliteDatabaseShim();
    db = new ExpoSqliteDb({
      database: database as unknown as ExpoSqliteDbOptions['database'],
    });
  });

  afterEach(async () => {
    await database.closeAsync();
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
});
