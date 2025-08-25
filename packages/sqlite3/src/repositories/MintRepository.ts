import type { MintRepository, Mint } from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';

export class SqliteMintRepository implements MintRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async isKnownMint(mintUrl: string): Promise<boolean> {
    const row = await this.db.get<{ x: number }>(
      'SELECT 1 AS x FROM coco_cashu_mints WHERE mintUrl = ? LIMIT 1',
      [mintUrl],
    );
    return !!row;
  }

  async getMintByUrl(mintUrl: string): Promise<Mint> {
    const row = await this.db.get<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      createdAt: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, name, mintInfo, createdAt, updatedAt FROM coco_cashu_mints WHERE mintUrl = ? LIMIT 1',
      [mintUrl],
    );
    if (!row) {
      throw new Error(`Mint not found: ${mintUrl}`);
    }
    return {
      mintUrl: row.mintUrl,
      name: row.name,
      mintInfo: JSON.parse(row.mintInfo),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies Mint;
  }

  async getAllMints(): Promise<Mint[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      createdAt: number;
      updatedAt: number;
    }>('SELECT mintUrl, name, mintInfo, createdAt, updatedAt FROM coco_cashu_mints');
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          name: r.name,
          mintInfo: JSON.parse(r.mintInfo),
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }) satisfies Mint,
    );
  }

  async addNewMint(mint: Mint): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_mints (mintUrl, name, mintInfo, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl) DO UPDATE SET
         name=excluded.name,
         mintInfo=excluded.mintInfo,
         createdAt=excluded.createdAt,
         updatedAt=excluded.updatedAt`,
      [mint.mintUrl, mint.name, JSON.stringify(mint.mintInfo), mint.createdAt, mint.updatedAt],
    );
  }

  async updateMint(mint: Mint): Promise<void> {
    await this.addNewMint(mint);
  }

  async deleteMint(mintUrl: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mints WHERE mintUrl = ?', [mintUrl]);
  }
}
