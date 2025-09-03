import type { IdbDb } from './db.ts';

export async function ensureSchema(db: IdbDb): Promise<void> {
  // Dexie schema with final versioned stores (flattened for first release)
  db.version(1).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
  });

  // No migration tracking needed prior to first release
}
