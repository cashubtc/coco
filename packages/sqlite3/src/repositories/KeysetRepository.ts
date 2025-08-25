import type { KeysetRepository, Keyset } from 'coco-cashu-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

export class SqliteKeysetRepository implements KeysetRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      id: string;
      keypairs: string;
      active: number;
      feePpk: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, id, keypairs, active, feePpk, updatedAt FROM coco_cashu_keysets WHERE mintUrl = ?',
      [mintUrl],
    );
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          id: r.id,
          keypairs: JSON.parse(r.keypairs),
          active: !!r.active,
          feePpk: r.feePpk,
          updatedAt: r.updatedAt,
        }) satisfies Keyset,
    );
  }

  async getKeysetById(mintUrl: string, id: string): Promise<Keyset | null> {
    const row = await this.db.get<{
      mintUrl: string;
      id: string;
      keypairs: string;
      active: number;
      feePpk: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, id, keypairs, active, feePpk, updatedAt FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ? LIMIT 1',
      [mintUrl, id],
    );
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      id: row.id,
      keypairs: JSON.parse(row.keypairs),
      active: !!row.active,
      feePpk: row.feePpk,
      updatedAt: row.updatedAt,
    } satisfies Keyset;
  }

  async updateKeyset(keyset: Omit<Keyset, 'keypairs' | 'updatedAt'>): Promise<void> {
    const now = getUnixTimeSeconds();
    const existing = await this.db.get<{ keypairs: string }>(
      'SELECT keypairs FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ? LIMIT 1',
      [keyset.mintUrl, keyset.id],
    );
    if (!existing) {
      await this.db.run(
        'INSERT INTO coco_cashu_keysets (mintUrl, id, keypairs, active, feePpk, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [keyset.mintUrl, keyset.id, JSON.stringify({}), keyset.active ? 1 : 0, keyset.feePpk, now],
      );
      return;
    }
    await this.db.run(
      'UPDATE coco_cashu_keysets SET active = ?, feePpk = ?, updatedAt = ? WHERE mintUrl = ? AND id = ?',
      [keyset.active ? 1 : 0, keyset.feePpk, now, keyset.mintUrl, keyset.id],
    );
  }

  async addKeyset(keyset: Omit<Keyset, 'updatedAt'>): Promise<void> {
    const now = getUnixTimeSeconds();
    await this.db.run(
      `INSERT INTO coco_cashu_keysets (mintUrl, id, keypairs, active, feePpk, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl, id) DO UPDATE SET
         keypairs=excluded.keypairs,
         active=excluded.active,
         feePpk=excluded.feePpk,
         updatedAt=excluded.updatedAt`,
      [
        keyset.mintUrl,
        keyset.id,
        JSON.stringify(keyset.keypairs ?? {}),
        keyset.active ? 1 : 0,
        keyset.feePpk,
        now,
      ],
    );
  }

  async deleteKeyset(mintUrl: string, keysetId: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_keysets WHERE mintUrl = ? AND id = ?', [
      mintUrl,
      keysetId,
    ]);
  }
}
