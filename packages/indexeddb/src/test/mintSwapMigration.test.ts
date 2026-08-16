import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';

import { IndexedDbRepositories } from '../index.ts';

describe('IndexedDB mint-swap migration', () => {
  it('upgrades version 32 with dormant stores while preserving standalone children', async () => {
    const name = `coco_cashu_mint_swap_migration_${Date.now()}`;
    const legacy = new Dexie(name);
    legacy.version(32).stores({
      coco_cashu_mint_operations:
        '&id, state, mintUrl, createdAt, [mintUrl+quoteId], [mintUrl+method+quoteId]',
      coco_cashu_melt_operations: '&id, state, mintUrl, createdAt, [mintUrl+quoteId]',
    });
    await legacy.open();
    await legacy.table('coco_cashu_mint_operations').add({
      id: 'legacy-mint-child',
      mintUrl: 'https://mint.test',
      quoteId: 'mint-quote',
      state: 'init',
      createdAt: 1,
      updatedAt: 1,
      method: 'bolt11',
      methodDataJson: '{}',
      amount: '1',
      unit: 'sat',
    });
    await legacy.table('coco_cashu_melt_operations').add({
      id: 'legacy-melt-child',
      mintUrl: 'https://mint.test',
      quoteId: 'melt-quote',
      state: 'init',
      createdAt: 1,
      updatedAt: 1,
      method: 'bolt11',
      methodDataJson: '{}',
      unit: 'sat',
    });
    legacy.close();

    const repositories = new IndexedDbRepositories({ name });
    try {
      await repositories.init();

      expect(repositories.db.verno).toBe(34);
      const parent = repositories.db.table('coco_cashu_mint_swap_operations');
      const outbox = repositories.db.table('coco_cashu_operation_event_outbox');
      expect(parent.schema.primKey.name).toBe('id');
      expect(parent.schema.idxByName.destinationMintOperationId?.unique).toBe(true);
      expect(parent.schema.idxByName.sourceMeltOperationId?.unique).toBe(true);
      expect(parent.schema.idxByName['[dueAt+createdAt+id]']).toBeDefined();
      expect(outbox.schema.idxByName['[operationId+revision+eventType]']?.unique).toBe(true);
      expect(
        repositories.db.table('coco_cashu_mint_operations').schema.idxByName.parentSwapOperationId,
      ).toMatchObject({ unique: true });
      expect(
        repositories.db.table('coco_cashu_melt_operations').schema.idxByName.parentSwapOperationId,
      ).toMatchObject({ unique: true });
      expect(outbox.schema.idxByName['[publicationState+dueAt+createdAt+id]']).toBeDefined();

      expect(
        await repositories.db.table('coco_cashu_mint_operations').get('legacy-mint-child'),
      ).toMatchObject({ id: 'legacy-mint-child' });
      expect(
        await repositories.db.table('coco_cashu_melt_operations').get('legacy-melt-child'),
      ).toMatchObject({ id: 'legacy-melt-child' });
    } finally {
      repositories.db.close();
    }
  });
});
