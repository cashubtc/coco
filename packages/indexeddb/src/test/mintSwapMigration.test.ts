import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';

import { IndexedDbRepositories } from '../index.ts';

describe('IndexedDB mint-swap migration', () => {
  it('upgrades a version 31 database with parent and outbox stores and unique indexes', async () => {
    const name = `coco_cashu_mint_swap_migration_${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(31).stores({ coco_cashu_mints: '&mintUrl' });
    await legacy.open();
    legacy.close();

    const repositories = new IndexedDbRepositories({ name });
    try {
      await repositories.init();

      expect(repositories.db.verno).toBe(33);
      const parent = repositories.db.table('coco_cashu_mint_swap_operations');
      const outbox = repositories.db.table('coco_cashu_operation_event_outbox');
      expect(parent.schema.primKey.name).toBe('id');
      expect(parent.schema.idxByName.destinationMintOperationId?.unique).toBe(true);
      expect(parent.schema.idxByName.sourceMeltOperationId?.unique).toBe(true);
      expect(outbox.schema.idxByName['[operationId+revision+eventType]']?.unique).toBe(true);
      expect(
        repositories.db.table('coco_cashu_mint_operations').schema.idxByName.parentSwapOperationId,
      ).toBeDefined();
      expect(
        repositories.db.table('coco_cashu_melt_operations').schema.idxByName.parentSwapOperationId,
      ).toBeDefined();
    } finally {
      repositories.db.close();
      await Dexie.delete(name);
    }
  });
});
