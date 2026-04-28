import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteDb, ensureSchemaUpTo } from '../index.ts';

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
