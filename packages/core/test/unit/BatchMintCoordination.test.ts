import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import { mintSwapFixture } from '../../../adapter-tests/src/internal/mintSwap/fixture.ts';
import { BatchMintAdmissionError } from '../../models/Error.ts';
import type { BatchMintOperation } from '../../operations/batchMint/BatchMintOperation.ts';
import { MintSwapChildOperationError } from '../../operations/mintSwap/MintSwapErrors.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';
import {
  createBatchMintHarness,
  ownedKey,
  type BatchMintHarness,
} from '../fixtures/BatchMintHarness.ts';

const batchFor = (
  mintUrl: string,
  quoteId: string,
  state: BatchMintOperation['state'],
): BatchMintOperation => {
  const base = {
    id: `batch-${state}`,
    mintUrl,
    method: 'bolt11' as const,
    unit: 'sat',
    members: [quoteId, 'other'].map((id, ordinal) => ({
      ordinal,
      quoteId: id,
      amount: Amount.from(8),
      request: `request-${id}`,
      signature: null,
    })),
    outputData: { keep: [], send: [] },
    createdAt: 1,
    updatedAt: 1,
  };
  return state === 'failed'
    ? { ...base, state, terminalFailure: { reason: 'rejected', observedAt: 2 } }
    : { ...base, state };
};

describe('Batch Mint and Mint Swap exclusivity', () => {
  it('rejects Mint Swap creation for a destination quote in an executing Batch Mint Operation', async () => {
    const repositories = new MemoryRepositories();
    const fixture = await mintSwapFixture(repositories);
    const { mintUrl, quoteId } = fixture.parent.destinationQuote;
    await repositories.batchMint.operationRepository.create(
      batchFor(mintUrl, quoteId, 'executing'),
    );

    await expect(fixture.create()).rejects.toThrow('child_conflict');
    expect(await repositories.mintSwap.operationRepository.getById(fixture.parent.id)).toBeNull();
  });

  it('lets Mint Swap creation use a quote whose Batch Mint Operation failed', async () => {
    const repositories = new MemoryRepositories();
    const fixture = await mintSwapFixture(repositories);
    const { mintUrl, quoteId } = fixture.parent.destinationQuote;
    await repositories.batchMint.operationRepository.create(batchFor(mintUrl, quoteId, 'failed'));

    await fixture.create();
    expect(
      await repositories.mintSwap.operationRepository.getById(fixture.parent.id),
    ).not.toBeNull();
  });

  describe('batch admission', () => {
    let h: BatchMintHarness;

    beforeEach(async () => {
      h = await createBatchMintHarness();
      await h.quote({ quote: 'a', method: 'bolt11', amount: 10, amountPaid: 10 });
      await h.quote({ quote: 'b', method: 'bolt11', amount: 10, amountPaid: 10 });
    });

    afterEach(async () => {
      await h.dispose();
      h.uninstall();
    });

    it('rejects a quote coordinated by an active Mint Swap', async () => {
      const parent = mintSwapFixtures('swap').preparing;
      await h.repo.mintSwap.operationRepository.create({
        ...parent,
        destinationMintUrl: h.mint.mintUrl,
        destinationQuote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'b' },
      });

      const error = await h.coco.ops.mint.batch
        .execute({
          mintUrl: h.mint.mintUrl,
          method: 'bolt11',
          members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MintSwapChildOperationError);
      expect((error as MintSwapChildOperationError).parentOperationId).toBe('swap');
      expect(await h.coco.ops.mint.batch.listInFlight()).toEqual([]);
      expect(h.mint.batchRequests).toHaveLength(0);
    });
  });
});

describe('Batch Mint admission races', () => {
  let h: BatchMintHarness;

  beforeEach(async () => {
    h = await createBatchMintHarness();
  });

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  it('admits exactly one of a batch and a standalone claim for the same BOLT11 quote', async () => {
    for (const quote of ['a', 'b'])
      await h.quote({ quote, method: 'bolt11', amount: 10, amountPaid: 10 });

    const [batch, standalone] = await Promise.allSettled([
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
      }),
      h.coco.ops.mint.prepare({
        quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'b' },
        amount: 10,
      }),
    ]);

    expect([batch.status, standalone.status].sort()).toEqual(['fulfilled', 'rejected']);
    if (batch.status === 'fulfilled') {
      expect(batch.value.state).toBe('finalized');
      expect(await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId: 'b' })).toEqual(
        [],
      );
    } else {
      expect(batch.reason).toBeInstanceOf(BatchMintAdmissionError);
      expect(h.mint.batchRequests).toHaveLength(0);
    }
  });

  it('admits exactly one of two batches that share a BOLT11 quote', async () => {
    for (const quote of ['a', 'b', 'c'])
      await h.quote({ quote, method: 'bolt11', amount: 10, amountPaid: 10 });

    const results = await Promise.allSettled([
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
      }),
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'c' }, { quoteId: 'b' }],
      }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BatchMintAdmissionError);
    expect((rejected.reason as BatchMintAdmissionError).quoteId).toBe('b');
    expect(h.mint.batchRequests).toHaveLength(1);
  });

  it('admits overlapping reusable batches only within the available amount', async () => {
    for (const quote of ['a', 'b', 'c'])
      await h.quote({ quote, method: 'onchain', amountPaid: 10, pubkey: ownedKey.publicKeyHex });

    const results = await Promise.allSettled([
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'onchain',
        members: [{ quoteId: 'a' }, { quoteId: 'b', amount: 6 }],
      }),
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'onchain',
        members: [{ quoteId: 'c' }, { quoteId: 'b', amount: 6 }],
      }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(h.mint.quotes.get('b')!.amountIssued).toBe(6);
  });

  it('keeps automatic claiming away from a quote an executing batch reserves', async () => {
    for (const quote of ['a', 'b'])
      await h.quote({ quote, method: 'bolt11', amount: 10, amountPaid: 10 });
    h.mint.batchBehaviors.push('network');
    const executing = await h.coco.ops.mint.batch.execute({
      mintUrl: h.mint.mintUrl,
      method: 'bolt11',
      members: [{ quoteId: 'a' }, { quoteId: 'b' }],
    });
    expect(executing.state).toBe('executing');

    const claimed = await h.coco.ops.mint.listInFlight();
    expect(claimed).toEqual([]);
    const manager = h.coco as unknown as {
      mintOperationService: { claimMintQuote(...args: unknown[]): Promise<unknown[]> };
    };
    expect(
      await manager.mintOperationService.claimMintQuote(h.mint.mintUrl, 'bolt11', 'a'),
    ).toEqual([]);
    expect(await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId: 'a' })).toEqual(
      [],
    );
  });
});
