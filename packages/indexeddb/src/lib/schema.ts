import type { IdbDb } from './db.ts';
import { getUnixTimeSeconds } from './db.ts';

export async function ensureSchema(db: IdbDb): Promise<void> {
  // Dexie schema with versioned upgrades. Mirrors SQL tables and indexes.
  db.version(1).stores({
    coco_cashu_mints: '&mintUrl, name, updatedAt',
    coco_cashu_keysets: '&[mintUrl+id], mintUrl, id, updatedAt',
    coco_cashu_counters: '&[mintUrl+keysetId]',
    coco_cashu_proofs: '&[mintUrl+secret], [mintUrl+state], state, mintUrl',
    coco_cashu_migrations: '&id',
  });

  db.version(2).upgrade(async (tx) => {
    // Simulate dropping FK on keysets: nothing to do in IndexedDB
    // Ensure compound index exists (already defined in v1)
  });

  db.version(3).stores({
    coco_cashu_mint_quotes: '&[mintUrl+quote], state, mintUrl',
  });

  // Track applied migrations similar to SQL flow to keep parity.
  const migrations = ['001_initial', '002_drop_fk_keysets', '003_add_mint_quotes'];
  const applied = new Set<string>();
  const existing = await (db as any)
    .table('coco_cashu_migrations')
    .toArray()
    .catch(() => []);
  for (const row of existing ?? []) applied.add(row.id);
  const now = getUnixTimeSeconds();
  for (const id of migrations) {
    if (!applied.has(id)) {
      await (db as any).table('coco_cashu_migrations').put({ id, appliedAt: now });
    }
  }
}
