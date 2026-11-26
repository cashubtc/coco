import { Amount } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { MintOperationError } from '../../models/Error.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import type { Plugin } from '../../plugins/types.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { createBatchMintHarness, type BatchMintHarness } from '../fixtures/BatchMintHarness.ts';
import { FakeBatchMint } from '../fixtures/BatchMintMint.ts';

/** NUT-00 12002: the mint no longer accepts outputs on this keyset. */
const keysetInactive = { code: 12002, detail: 'Keyset is inactive' };
/** BOLT11 test vector from the BOLT11 specification, for 2500u (250,000 sat). */
const invoice =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

/**
 * Keyset rejections at the Manager boundary: a real Manager over Memory repositories and an
 * in-process HTTP mint. The mint's own error reaches the caller and each flow ends as before.
 */
describe('Keyset rejection', () => {
  const harnesses: BatchMintHarness[] = [];
  let installed: FakeBatchMint | undefined;

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.dispose();
    installed?.uninstall();
    installed = undefined;
  });

  /** A Manager over the shared fake mint, installed on first use. */
  const setup = async (options: { mint?: FakeBatchMint } = {}) => {
    let mint = options.mint;
    if (!mint) {
      mint = new FakeBatchMint();
      mint.install();
      installed = mint;
    }
    const harness = await createBatchMintHarness({ mint });
    harnesses.push(harness);
    return harness;
  };
  const mintUrl = 'https://batch-mint.test';
  const paths = (h: BatchMintHarness, start: number) =>
    h.mint.requests.slice(start).map(({ path }) => path);
  const readyAmounts = async (h: BatchMintHarness) =>
    (await h.repo.proofRepository.getAvailableProofs(mintUrl, { unit: 'sat' }))
      .map((proof) => proof.amount.toNumber())
      .sort((a, b) => a - b);
  const fund = async (h: BatchMintHarness, quoteId: string, amount: number) => {
    await h.quote({ quote: quoteId, method: 'bolt11', amount, amountPaid: amount });
    const operation = await h.coco.ops.mint.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId },
      amount,
    });
    expect((await h.coco.ops.mint.execute(operation.id)).state).toBe('finalized');
  };
  const expectMintError = (error: unknown, code = keysetInactive.code) => {
    expect(error).toBeInstanceOf(MintOperationError);
    expect((error as MintOperationError).code).toBe(code);
  };

  it('fails a Send with the mint error and releases its inputs', async () => {
    const h = await setup();
    await fund(h, 'fund', 8);
    const prepared = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    expect(prepared.needsSwap).toBe(true);
    h.mint.swapRejections.push(keysetInactive);
    const start = h.mint.requests.length;

    const error = await h.coco.ops.send.execute(prepared.id).catch((caught: unknown) => caught);

    expectMintError(error);
    expect((await h.coco.ops.send.get(prepared.id))?.state).toBe('rolled_back');
    expect(await readyAmounts(h)).toEqual([8]);
    expect(paths(h, start)).toEqual(['/v1/swap']);
  });

  it('rolls back a Receive with the mint error', async () => {
    const sender = await setup();
    await fund(sender, 'fund', 8);
    const { token } = await sender.coco.ops.send.execute(
      await sender.coco.ops.send.prepare({ mintUrl, amount: 8 }),
    );
    const receiver = await setup({ mint: sender.mint });
    const prepared = await receiver.coco.ops.receive.prepare({ token });
    sender.mint.swapRejections.push(keysetInactive);
    const start = sender.mint.requests.length;

    const error = await receiver.coco.ops.receive
      .execute(prepared.id)
      .catch((caught: unknown) => caught);

    expectMintError(error);
    expect((await receiver.coco.ops.receive.get(prepared.id))?.state).toBe('rolled_back');
    expect(paths(sender, start)).toEqual(['/v1/swap']);
  });

  it('defers a Melt whose pre-swap the mint rejects and reports the mint error', async () => {
    const h = await setup();
    await fund(h, 'fund', 8);
    await h.repo.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(mintUrl, {
        quote: 'melt',
        request: invoice,
        amount: Amount.from(3),
        fee_reserve: Amount.zero(),
        unit: 'sat',
        expiry: 9_999_999_999,
        state: 'UNPAID',
        payment_preimage: null,
      }),
    );
    const prepared = await h.coco.ops.melt.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: 'melt' },
    });
    expect(prepared.needsSwap).toBe(true);
    h.mint.swapRejections.push(keysetInactive);
    const start = h.mint.requests.length;

    const error = await h.coco.ops.melt.execute(prepared.id).catch((caught: unknown) => caught);

    expectMintError(error);
    const deferred = await h.coco.ops.melt.get(prepared.id);
    expect(deferred?.state).toBe('executing');
    expect(deferred && 'error' in deferred && deferred.error).toBe(keysetInactive.detail);
    expect(paths(h, start)).toEqual(['/v1/swap']);
  });

  it('leaves a bolt11 Mint Operation executing and reports the mint error', async () => {
    const h = await setup();
    await h.quote({ quote: 'q', method: 'bolt11', amount: 8, amountPaid: 8 });
    const operation = await h.coco.ops.mint.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: 'q' },
      amount: 8,
    });
    // The submission and the replay that execute() attempts after it.
    h.mint.mintRejections.push(keysetInactive, keysetInactive);
    const start = h.mint.requests.length;

    const error = await h.coco.ops.mint.execute(operation.id).catch((caught: unknown) => caught);

    expectMintError(error);
    expect((await h.coco.ops.mint.get(operation.id))?.state).toBe('executing');
    expect(paths(h, start)).toEqual([
      '/v1/mint/bolt11',
      '/v1/mint/quote/bolt11/q',
      '/v1/mint/bolt11',
    ]);
  });
});

describe('BOLT11 minting over cashu-ts', () => {
  let h: BatchMintHarness;

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  it('mints with exactly one request, the mint request', async () => {
    h = await createBatchMintHarness();
    await h.quote({ quote: 'q', method: 'bolt11', amount: 8, amountPaid: 8 });
    const operation = await h.coco.ops.mint.prepare({
      quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'q' },
      amount: 8,
    });
    const start = h.mint.requests.length;

    expect((await h.coco.ops.mint.execute(operation.id)).state).toBe('finalized');

    expect(h.mint.requests.slice(start).map(({ path }) => path)).toEqual(['/v1/mint/bolt11']);
  });

  it('creates an unlocked quote on a mint without NUT-20 and still refuses a locked one', async () => {
    const mint = new FakeBatchMint();
    mint.nut20 = false;
    mint.install();
    h = await createBatchMintHarness({ mint });
    const start = h.mint.requests.length;

    const quote = await h.coco.quotes.mint.create({
      mintUrl: mint.mintUrl,
      method: 'bolt11',
      amount: 10,
    });

    expect(quote.amount?.toNumber()).toBe(10);
    const created = h.mint.requests.slice(start);
    expect(created.map(({ path }) => path)).toEqual(['/v1/mint/quote/bolt11']);
    expect(created[0]!.body).toEqual({ amount: 10, unit: 'sat' });
    await expect(
      h.coco.quotes.mint.create({
        mintUrl: mint.mintUrl,
        method: 'bolt11',
        amount: 10,
        locked: true,
      }),
    ).rejects.toThrow('NUT-20');
    expect(h.mint.requests).toHaveLength(start + 1);
  });
});

describe('Keyset gate', () => {
  it('never holds or selects a v3 keyset the mint advertises, even the newest and cheapest', async () => {
    const v3KeysetId = `02${'00'.repeat(32)}`;
    const mint = new FakeBatchMint();
    mint.advertisedKeysets.push({ id: v3KeysetId, unit: 'sat', active: true, input_fee_ppk: 0 });
    mint.install();
    let walletService: WalletService | undefined;
    const plugin: Plugin<['walletService']> = {
      name: 'wallet-service-probe',
      required: ['walletService'],
      onReady: ({ services }) => {
        walletService = services.walletService;
      },
    };
    const h = await createBatchMintHarness({ mint, plugins: [plugin] });
    try {
      const { wallet, keysetId } = await walletService!.getWalletWithActiveKeysetId(
        mint.mintUrl,
        'sat',
      );

      expect(keysetId).toBe(mint.keysetId('sat'));
      expect(wallet.keyChain.hasKeyset(v3KeysetId)).toBe(false);
    } finally {
      await h.dispose();
      h.uninstall();
    }
  });
});
