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
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
  });

  // Version 2: Add trusted field to mints
  db.version(2)
    .stores({
      coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
      coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt',
      coco_cashu_counters: '&[mintUrl+keysetId]',
      coco_cashu_proofs:
        '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
      coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
      coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
    })
    .upgrade(async (tx) => {
      // Set all existing mints to trusted for backwards compatibility
      const mints = await tx.table('coco_cashu_mints').toArray();
      for (const mint of mints) {
        await tx.table('coco_cashu_mints').update(mint.mintUrl, { trusted: true });
      }
    });

  // Version 3: Add unit field to keysets
  db.version(3).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt, trusted',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt, unit',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], [mintUrl+id+state], state, mintUrl, id',
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_melt_quotes: '&[mintUrl+quote], state, mintUrl',
    coco_cashu_history: '++id, mintUrl, type, createdAt, [mintUrl+quoteId+type]',
  });
}
