import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import type { BatchMintOperation } from '../../operations/batchMint/BatchMintOperation.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { mintQuoteFromBolt11Fixture } from '../normalizedMintQuoteFixtures.ts';

/** Persisted records exercise standalone admission before a batch execution API is available. */
describe('Standalone claims with persisted Batch Mint records', () => {
  const mintUrl = 'https://persisted-batch.test';
  let repo: MemoryRepositories;
  let coco: Manager;

  beforeEach(async () => {
    repo = new MemoryRepositories();
    coco = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(5),
      watchers: {
        mintOperationWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
        meltQuoteWatcher: { disabled: true },
      },
      processors: {
        mintOperationProcessor: { disabled: true },
        meltSettlementProcessor: { disabled: true },
        mintSwapOperationProcessor: { disabled: true },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    await repo.mintRepository.addNewMint({
      mintUrl,
      name: 'Persisted batch mint',
      trusted: true,
      mintInfo: {
        ...testMintInfo,
        nuts: {
          ...testMintInfo.nuts,
          '4': {
            disabled: false,
            methods: [
              {
                method: 'bolt11',
                unit: 'sat',
                method_name: 'bolt11',
                min_amount: 1,
                max_amount: 1000,
              },
            ],
          },
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    await repo.keysetRepository.addKeyset({
      mintUrl,
      id: testMintKeysetId(),
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await repo.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Fixture(mintUrl, {
        quote: 'paid',
        request: 'lnbc-paid',
        amount: Amount.from(10),
        unit: 'sat',
        expiry: now + 3600,
        state: 'PAID',
      }),
    );
  });

  afterEach(async () => {
    await coco?.dispose();
  });

  async function persistBatch(
    state: BatchMintOperation['state'],
    id = 'persisted-batch',
    method: 'bolt11' | 'onchain' = 'bolt11',
    amount = 10,
  ) {
    const base = {
      id,
      mintUrl,
      method,
      unit: 'sat',
      members: ['paid', 'other'].map((quoteId, ordinal) => ({
        ordinal,
        quoteId,
        amount: Amount.from(amount),
        request: `lnbc-${quoteId}`,
        pubkey: null,
      })),
      outputData: { keep: [], send: [] },
      createdAt: 1,
      updatedAt: 1,
    };
    await repo.batchMint.operationRepository.create(
      state === 'failed'
        ? { ...base, state, terminalFailure: { reason: 'rejected', observedAt: 1 } }
        : { ...base, state },
    );
  }

  const prepare = () =>
    coco.ops.mint.prepare({ quote: { mintUrl, method: 'bolt11', quoteId: 'paid' }, amount: 10 });

  for (const state of ['executing', 'finalized'] as const) {
    it(`rejects a standalone claim of a quote held by a ${state} batch`, async () => {
      await persistBatch(state);
      await expect(prepare()).rejects.toThrow('already claimed by Batch Mint Operation');
      expect(await repo.mintOperationRepository.getByMintUrl(mintUrl)).toHaveLength(0);
      expect(await coco.wallet.balances.byMint()).toEqual({});
    });
  }

  it('allows standalone preparation after a definitive batch failure', async () => {
    await persistBatch('failed');
    expect((await prepare()).state).toBe('pending');
  });

  it('keeps a pending standalone claim from executing into a batch reservation', async () => {
    const pending = await prepare();
    await persistBatch('executing');
    expect((await coco.ops.mint.execute(pending.id)).state).toBe('pending');
    expect(await coco.wallet.balances.byMint()).toEqual({});
  });

  it('counts reusable member amounts by state and excludes only the recovering reservation', async () => {
    for (const [state, amount] of [
      ['finalized', 5],
      ['executing', 10],
      ['failed', 7],
    ] as const) {
      await persistBatch(state, state, 'onchain', amount);
    }
    const runner = new RepositoryCoreTransactionRunner(repo);
    const quote = { mintUrl, method: 'onchain' as const, quoteId: 'paid' };
    const facts = await runner.run((tx) => tx.mintQuoteClaims.getFacts(quote));
    expect(facts.finalizedAmount.toString()).toBe('5');
    expect(facts.reservedAmount.toString()).toBe('10');
    const recovery = await runner.run((tx) =>
      tx.mintQuoteClaims.getFacts(quote, { excludeOperationId: 'executing' }),
    );
    expect(recovery.finalizedAmount.toString()).toBe('5');
    expect(recovery.reservedAmount.toString()).toBe('0');
    const differentMethod = await runner.run((tx) =>
      tx.mintQuoteClaims.getFacts({ ...quote, method: 'bolt11' }),
    );
    expect(differentMethod.finalizedAmount.toString()).toBe('0');
    expect(differentMethod.reservedAmount.toString()).toBe('0');
  });
});
