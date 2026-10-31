import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createBatchMintHarness,
  ownedKey,
  type BatchMintHarness,
} from '../fixtures/BatchMintHarness.ts';

/**
 * Standalone Mint claimability counts Batch Mint Members: finalized members as local issuance and
 * executing members as Mint Quote Reservations. Failed batches count for nothing.
 */
describe('Mint Quote claim facts with Batch Mint Operations', () => {
  let h: BatchMintHarness;

  beforeEach(async () => {
    h = await createBatchMintHarness();
  });

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  const prepare = (method: 'bolt11' | 'onchain', quoteId: string, amount: number) =>
    h.coco.ops.mint.prepare({ quote: { mintUrl: h.mint.mintUrl, method, quoteId }, amount });

  it('rejects standalone preparation of a BOLT11 quote a finalized batch claimed', async () => {
    for (const quote of ['a', 'b'])
      await h.quote({ quote, method: 'bolt11', amount: 10, amountPaid: 10 });
    const batch = await h.coco.ops.mint.batch.execute({
      mintUrl: h.mint.mintUrl,
      method: 'bolt11',
      members: [{ quoteId: 'a' }, { quoteId: 'b' }],
    });

    await expect(prepare('bolt11', 'a', 10)).rejects.toThrow(
      `already claimed by Batch Mint Operation ${batch.id}`,
    );
  });

  describe('reusable quotes', () => {
    /** Claims 5 in a finalized batch, 10 in an executing one, and 7 in a failed one. */
    const arrange = async (paid: number) => {
      const onchain = (quote: string, amountPaid: number) =>
        h.quote({ quote, method: 'onchain', amountPaid, pubkey: ownedKey.publicKeyHex });
      await onchain('reusable', paid);
      const batchWith = async (other: string, amount: number) => {
        await onchain(other, 4);
        return h.coco.ops.mint.batch.execute({
          mintUrl: h.mint.mintUrl,
          method: 'onchain',
          members: [{ quoteId: 'reusable', amount }, { quoteId: other }],
        });
      };
      expect((await batchWith('finalized', 5)).state).toBe('finalized');
      h.mint.batchBehaviors.push('network');
      expect((await batchWith('executing', 10)).state).toBe('executing');
      h.mint.batchBehaviors.push({ code: 20008 });
      expect((await batchWith('failed', 7)).state).toBe('failed');
    };

    it('claims exactly the remainder batches leave', async () => {
      await arrange(30);

      const operation = await prepare('onchain', 'reusable', 15);

      expect((await h.coco.ops.mint.execute(operation.id)).state).toBe('finalized');
    });

    it('keeps a standalone operation pending when batches leave too little', async () => {
      await arrange(30);

      const operation = await prepare('onchain', 'reusable', 16);

      expect((await h.coco.ops.mint.execute(operation.id)).state).toBe('pending');
    });

    it('does not replay a standalone recovery into value batches hold', async () => {
      await arrange(22);
      const pending = await prepare('onchain', 'reusable', 8);
      // An interrupted issuance: the mint reports 17 free, but the batches leave only 7.
      await h.repo.mintOperationRepository.update({ ...pending, state: 'executing' });

      await h.coco.ops.mint.recovery.run();

      expect((await h.coco.ops.mint.get(pending.id))?.state).toBe('executing');
      expect(h.mint.requests.filter(({ path }) => path === '/v1/mint/onchain')).toEqual([]);
    });
  });
});
