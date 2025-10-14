import type { MintRepository, Mint } from 'coco-cashu-core';
import type { IdbDb, MintRow } from '../lib/db.ts';

export class IdbMintRepository implements MintRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    const row = await (this.db as any).table('coco_cashu_mints').get(mintUrl);
    return row?.trusted ?? false;
  }

  async getMintByUrl(mintUrl: string): Promise<Mint> {
    const row = (await (this.db as any).table('coco_cashu_mints').get(mintUrl)) as
      | MintRow
      | undefined;
    if (!row) throw new Error(`Mint not found: ${mintUrl}`);
    return {
      mintUrl: row.mintUrl,
      name: row.name,
      mintInfo: JSON.parse(row.mintInfo),
      trusted: row.trusted ?? true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies Mint;
  }

  async getAllMints(): Promise<Mint[]> {
    const rows = (await (this.db as any).table('coco_cashu_mints').toArray()) as MintRow[];
    return rows.map(
      (r) =>
        ({
          mintUrl: r.mintUrl,
          name: r.name,
          mintInfo: JSON.parse(r.mintInfo),
          trusted: r.trusted ?? true,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        } satisfies Mint),
    );
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    const rows = (await (this.db as any).table('coco_cashu_mints').toArray()) as MintRow[];
    return rows
      .filter((r) => r.trusted ?? true)
      .map(
        (r) =>
          ({
            mintUrl: r.mintUrl,
            name: r.name,
            mintInfo: JSON.parse(r.mintInfo),
            trusted: r.trusted ?? true,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          } satisfies Mint),
      );
  }

  async addNewMint(mint: Mint): Promise<void> {
    const row: MintRow = {
      mintUrl: mint.mintUrl,
      name: mint.name,
      mintInfo: JSON.stringify(mint.mintInfo),
      trusted: mint.trusted,
      createdAt: mint.createdAt,
      updatedAt: mint.updatedAt,
    };
    await (this.db as any).table('coco_cashu_mints').put(row);
  }

  async addOrUpdateMint(mint: Mint): Promise<void> {
    const existing = (await (this.db as any).table('coco_cashu_mints').get(mint.mintUrl)) as
      | MintRow
      | undefined;
    const row: MintRow = {
      mintUrl: mint.mintUrl,
      name: mint.name,
      mintInfo: JSON.stringify(mint.mintInfo),
      trusted: mint.trusted,
      createdAt: existing?.createdAt ?? mint.createdAt,
      updatedAt: mint.updatedAt,
    };
    await (this.db as any).table('coco_cashu_mints').put(row);
  }

  async updateMint(mint: Mint): Promise<void> {
    await this.addNewMint(mint);
  }

  async setMintTrusted(mintUrl: string, trusted: boolean): Promise<void> {
    await (this.db as any).table('coco_cashu_mints').update(mintUrl, { trusted });
  }

  async deleteMint(mintUrl: string): Promise<void> {
    await (this.db as any).table('coco_cashu_mints').delete(mintUrl);
  }
}
