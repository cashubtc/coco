import Dexie from 'dexie';
import type { MintRepository, Mint } from '@cashu/coco-core/adapter';
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
      metadataRevision: row.metadataRevision ?? 0,
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
          metadataRevision: r.metadataRevision ?? 0,
        }) satisfies Mint,
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
            metadataRevision: r.metadataRevision ?? 0,
          }) satisfies Mint,
      );
  }

  async addNewMint(mint: Mint): Promise<void> {
    await this.writeMint(mint, false);
  }

  async addOrUpdateMint(mint: Mint): Promise<void> {
    await this.writeMint(mint, true);
  }

  private async writeMint(mint: Mint, preserveCreatedAt: boolean): Promise<void> {
    const table = this.db.table<MintRow, string>('coco_cashu_mints');
    const row: MintRow = {
      mintUrl: mint.mintUrl,
      name: mint.name,
      mintInfo: JSON.stringify(mint.mintInfo),
      trusted: mint.trusted,
      createdAt: mint.createdAt,
      updatedAt: mint.updatedAt,
      metadataRevision: mint.metadataRevision ?? 0,
    };
    const changes: Partial<MintRow> = { ...row };
    if (preserveCreatedAt) delete changes.createdAt;
    if (mint.metadataRevision === undefined) delete changes.metadataRevision;
    // Partial update preserves the current revision atomically, without a read/put race.
    if (await table.update(mint.mintUrl, changes)) return;
    try {
      await table.add(row);
    } catch (error) {
      if (!(error instanceof Dexie.ConstraintError)) throw error;
      // A concurrent root may have inserted the mint. Update its fields without replacing its revision.
      await table.update(mint.mintUrl, changes);
    }
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
