import { UnknownMintError, type MintRepository, type Mint } from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';

export class SqliteMintRepository implements MintRepository {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    const row = await this.db.get<{ trusted: number }>(
      'SELECT trusted FROM coco_cashu_mints WHERE mintUrl = ? LIMIT 1',
      [mintUrl],
    );
    return row?.trusted === 1;
  }

  async getMintByUrl(mintUrl: string): Promise<Mint> {
    const row = await this.db.get<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      trusted: number;
      createdAt: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, name, mintInfo, trusted, createdAt, updatedAt FROM coco_cashu_mints WHERE mintUrl = ? LIMIT 1',
      [mintUrl],
    );
    if (!row) {
      throw new UnknownMintError(`Mint not found: ${mintUrl}`);
    }
    return {
      mintUrl: row.mintUrl,
      name: row.name,
      mintInfo: JSON.parse(row.mintInfo),
      trusted: row.trusted === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies Mint;
  }

  async getAllMints(): Promise<Mint[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      trusted: number;
      createdAt: number;
      updatedAt: number;
    }>('SELECT mintUrl, name, mintInfo, trusted, createdAt, updatedAt FROM coco_cashu_mints');
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          name: r.name,
          mintInfo: JSON.parse(r.mintInfo),
          trusted: r.trusted === 1,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }) satisfies Mint,
    );
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      name: string;
      mintInfo: string;
      trusted: number;
      createdAt: number;
      updatedAt: number;
    }>(
      'SELECT mintUrl, name, mintInfo, trusted, createdAt, updatedAt FROM coco_cashu_mints WHERE trusted = 1',
    );
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          name: r.name,
          mintInfo: JSON.parse(r.mintInfo),
          trusted: r.trusted === 1,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }) satisfies Mint,
    );
  }

  async addNewMint(mint: Mint): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_mints (mintUrl, name, mintInfo, trusted, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl) DO UPDATE SET
         name=excluded.name,
         mintInfo=excluded.mintInfo,
         trusted=excluded.trusted,
         createdAt=excluded.createdAt,
         updatedAt=excluded.updatedAt`,
      [
        mint.mintUrl,
        mint.name,
        JSON.stringify(mint.mintInfo),
        mint.trusted ? 1 : 0,
        mint.createdAt,
        mint.updatedAt,
      ],
    );
  }

  async addOrUpdateMint(
    mint: Mint,
    options?: { preserveExistingTrust?: boolean },
  ): Promise<boolean> {
    return this.db.transaction(
      async (database) => {
        const serializedMintInfo = JSON.stringify(mint.mintInfo);
        const inserted = await database.run(
          `INSERT INTO coco_cashu_mints (mintUrl, name, mintInfo, trusted, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(mintUrl) DO NOTHING`,
          [
            mint.mintUrl,
            mint.name,
            serializedMintInfo,
            mint.trusted ? 1 : 0,
            mint.createdAt,
            mint.updatedAt,
          ],
        );
        if (inserted.changes === 1) return true;

        await database.run(
          `UPDATE coco_cashu_mints
           SET name = ?, mintInfo = ?, trusted = CASE WHEN ? = 1 THEN trusted ELSE ? END,
               updatedAt = ?
           WHERE mintUrl = ?`,
          [
            mint.name,
            serializedMintInfo,
            options?.preserveExistingTrust ? 1 : 0,
            mint.trusted ? 1 : 0,
            mint.updatedAt,
            mint.mintUrl,
          ],
        );
        return false;
      },
      { mode: 'immediate' },
    );
  }

  async updateMint(mint: Mint): Promise<void> {
    await this.addOrUpdateMint(mint);
  }

  async setMintTrusted(mintUrl: string, trusted: boolean): Promise<void> {
    await this.db.run('UPDATE coco_cashu_mints SET trusted = ? WHERE mintUrl = ?', [
      trusted ? 1 : 0,
      mintUrl,
    ]);
  }

  async deleteMint(mintUrl: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_mints WHERE mintUrl = ?', [mintUrl]);
  }
}
