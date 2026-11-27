import { Amount } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { MintOperationError } from '../../models/Error.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import type { Plugin } from '../../plugins/types.ts';
import type { WalletService } from '../../services/WalletService.ts';
import {
  createBatchMintHarness,
  ownedKey,
  type BatchMintHarness,
} from '../fixtures/BatchMintHarness.ts';
import { FakeBatchMint } from '../fixtures/BatchMintMint.ts';

/** NUT-00 12002: the mint no longer accepts outputs on this keyset. */
const keysetInactive = { code: 12002, detail: 'Keyset is inactive' };
/** BOLT11 test vector from the BOLT11 specification, for 2500u (250,000 sat). */
const invoice =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

/** What the mint receives when Coco fetches its metadata: info, then its keysets. */
const metadataRefresh = ['/v1/info', '/v1/keysets'];

/**
 * Keyset rejections at the Manager boundary: a real Manager over Memory repositories and an
 * in-process HTTP mint. The mint's own error reaches the caller and each flow ends as before; once
 * the outcome is stored, Coco fetches the mint's metadata once.
 */
describe('Keyset rejection', () => {
  const harnesses: BatchMintHarness[] = [];
  let installed: FakeBatchMint | undefined;

  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.dispose();
    installed?.uninstall();
    installed = undefined;
    setSystemTime();
  });

  /** A Manager over the shared fake mint, installed on first use. */
  const setup = async (options: { mint?: FakeBatchMint } = {}) => {
    let mint = options.mint;
    if (!mint) {
      mint = new FakeBatchMint();
      mint.install();
      installed = mint;
    }
    const harness = await createBatchMintHarness({
      mint,
      seedGetter: options.mint ? async () => new Uint8Array(64).fill(6) : undefined,
    });
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
  /** Melt quotes are not served by the fake mint, so the canonical quote is stored directly. */
  const storeMeltQuote = (h: BatchMintHarness, feeReserve = 0) =>
    h.repo.meltQuoteRepository.upsertMeltQuote(
      meltQuoteFromBolt11Response(mintUrl, {
        quote: 'melt',
        request: invoice,
        amount: Amount.from(3),
        fee_reserve: Amount.from(feeReserve),
        unit: 'sat',
        expiry: 9_999_999_999,
        state: 'UNPAID',
        payment_preimage: null,
      }),
    );
  const expectMintError = (error: unknown, code = keysetInactive.code) => {
    expect(error).toBeInstanceOf(MintOperationError);
    expect((error as MintOperationError).code).toBe(code);
  };

  it.each([
    ['', 'ok'],
    [' when the refresh fails', 'unavailable'],
  ] as const)(
    'fails a Send with the mint error and releases its inputs%s',
    async (_name, metadataBehavior) => {
      const h = await setup();
      await fund(h, 'fund', 8);
      const prepared = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
      expect(prepared.needsSwap).toBe(true);
      h.mint.swapRejections.push(keysetInactive);
      h.mint.metadataBehavior = metadataBehavior;
      const start = h.mint.requests.length;

      const error = await h.coco.ops.send.execute(prepared.id).catch((caught: unknown) => caught);

      expectMintError(error);
      expect((await h.coco.ops.send.get(prepared.id))?.state).toBe('rolled_back');
      expect(await readyAmounts(h)).toEqual([8]);
      // A failed refresh stops at the info request and changes nothing about the outcome.
      expect(paths(h, start)).toEqual(
        metadataBehavior === 'ok' ? ['/v1/swap', ...metadataRefresh] : ['/v1/swap', '/v1/info'],
      );
    },
  );

  /** An initial rejection teaches this Manager the mint's new keys. */
  const rotateAfterPrepare = async (h: BatchMintHarness, triggerId: string) => {
    // Metadata observations have second precision and keep the first observation on ties.
    setSystemTime(new Date(Date.now() + 2_000));
    h.mint.rotateSatKeyset();
    const start = h.mint.requests.length;
    expectMintError(await h.coco.ops.send.execute(triggerId).catch((error: unknown) => error));
    expect(paths(h, start)).toEqual([
      '/v1/swap',
      ...metadataRefresh,
      `/v1/keys/${h.mint.keysetId()}`,
    ]);
    expect((await h.coco.ops.send.get(triggerId))?.state).toBe('rolled_back');
  };

  it('keeps a second prepared Send cancellable after the first learns of keyset rotation', async () => {
    const h = await setup();
    await fund(h, 'first', 8);
    await fund(h, 'second', 8);
    const first = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    const second = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    expect([first, second].map((op) => [op.needsSwap, op.inputAmount.toNumber()])).toEqual([
      [true, 8],
      [true, 8],
    ]);
    const originalKeyset = h.mint.keysetId();
    const counter = await h.repo.counterRepository.getCounter(mintUrl, originalKeyset);
    expect(counter).not.toBeNull();
    await rotateAfterPrepare(h, first.id);
    const start = h.mint.requests.length;

    await expect(h.coco.ops.send.execute(second.id)).rejects.toThrow('cannot issue new outputs');
    expect(await h.coco.ops.send.get(second.id)).toEqual(second);
    expect(await readyAmounts(h)).toEqual([8]);
    await h.coco.ops.send.cancel(second.id);
    expect(await readyAmounts(h)).toEqual([8, 8]);
    expect(paths(h, start)).toEqual([]);
    expect(await h.repo.counterRepository.getCounter(mintUrl, originalKeyset)).toEqual(counter);

    // A proof on the retired keyset can fund a fresh swap onto the new keyset.
    const fresh = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    expect((await h.coco.ops.send.execute(fresh)).operation.state).toBe('pending');
  });

  it('retains the inputs and exact request of an uncertain Send across rotation and recovery', async () => {
    const h = await setup();
    await fund(h, 'first', 8);
    await fund(h, 'second', 8);
    const uncertain = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    const trigger = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    h.mint.swapRejections.push({ code: 11004, detail: 'Outputs are pending' });
    await expect(h.coco.ops.send.execute(uncertain)).rejects.toThrow();
    await rotateAfterPrepare(h, trigger.id);
    await h.coco.ops.send.recovery.run();

    expect(await h.coco.ops.send.get(uncertain.id)).toMatchObject({
      state: 'executing',
      inputProofSecrets: uncertain.inputProofSecrets,
      outputData: uncertain.outputData,
    });
    await expect(h.coco.ops.send.cancel(uncertain.id)).rejects.toThrow();
    expect(await readyAmounts(h)).toEqual([8]);
  });

  it('retains a prepared Receive when its output keyset has rotated', async () => {
    const sender = await setup();
    await fund(sender, 'sender', 8);
    const { token } = await sender.coco.ops.send.execute(
      await sender.coco.ops.send.prepare({ mintUrl, amount: 8 }),
    );
    const receiver = await setup({ mint: sender.mint });
    const prepared = await receiver.coco.ops.receive.prepare({ token });
    await fund(receiver, 'receiver', 8);
    const trigger = await receiver.coco.ops.send.prepare({ mintUrl, amount: 3 });
    await rotateAfterPrepare(receiver, trigger.id);
    const start = receiver.mint.requests.length;
    await expect(receiver.coco.ops.receive.execute(prepared.id)).rejects.toThrow(
      'cannot issue new outputs',
    );
    expect(await receiver.coco.ops.receive.get(prepared.id)).toEqual(prepared);
    expect(paths(receiver, start)).toEqual([]);
    await receiver.coco.ops.receive.cancel(prepared.id);
  });

  it('replays a possibly submitted Receive on its saved keyset after rotation', async () => {
    const sender = await setup();
    await fund(sender, 'sender', 8);
    const { token } = await sender.coco.ops.send.execute(
      await sender.coco.ops.send.prepare({ mintUrl, amount: 8 }),
    );
    const receiver = await setup({ mint: sender.mint });
    const prepared = await receiver.coco.ops.receive.prepare({ token });
    await fund(receiver, 'receiver', 8);
    const trigger = await receiver.coco.ops.send.prepare({ mintUrl, amount: 3 });
    receiver.mint.swapRejections.push({ code: 11004, detail: 'Outputs pending' });
    receiver.mint.restoredProofState = 'PENDING';
    const start = receiver.mint.requests.length;
    await expect(receiver.coco.ops.receive.execute(prepared.id)).rejects.toThrow('Outputs pending');
    const initialRequests = receiver.mint.requests
      .slice(start)
      .filter(({ path }) => path === '/v1/swap');
    expect(initialRequests).toHaveLength(1);
    await rotateAfterPrepare(receiver, trigger.id);

    receiver.mint.restoredProofState = 'UNSPENT';
    const recoveryStart = receiver.mint.requests.length;
    const recovered = await receiver.coco.ops.receive.refresh(prepared.id);
    expect(recovered).toMatchObject({ state: 'executing', outputData: prepared.outputData });
    expect(
      receiver.mint.requests.slice(recoveryStart).filter(({ path }) => path === '/v1/swap'),
    ).toEqual(initialRequests);
  });

  it('uses the Batch Mint admission wallet if a listener learns of rotation before submission', async () => {
    const h = await setup();
    await fund(h, 'fund', 8);
    const trigger = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
    for (const quote of ['a', 'b'])
      await h.quote({ quote, method: 'bolt11', amount: 8, amountPaid: 8 });
    h.coco.on('batch-mint-op:executing', () => rotateAfterPrepare(h, trigger.id));
    h.mint.batchBehaviors.push(keysetInactive);
    const result = await h.coco.ops.mint.batch.execute({
      mintUrl,
      method: 'bolt11',
      members: [{ quoteId: 'a' }, { quoteId: 'b' }],
    });
    expect((await h.coco.ops.send.get(trigger.id))?.state).toBe('rolled_back');
    expect(result.state === 'failed' && result.terminalFailure.code).toBe('12002');
    expect(h.mint.batchRequests).toHaveLength(1);
  });

  it.each(['bolt11', 'bolt12', 'onchain'] as const)(
    'keeps the %s quote claim pending when its output keyset has rotated',
    async (method) => {
      const h = await setup();
      await fund(h, 'fund', 8);
      const trigger = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
      await h.quote({
        quote: 'q',
        method,
        amountPaid: 4,
        ...(method === 'bolt11' ? { amount: 4 } : { pubkey: ownedKey.publicKeyHex }),
      });
      const prepared = await h.coco.ops.mint.prepare({
        quote: { mintUrl, method, quoteId: 'q' },
        amount: 4,
      });
      await rotateAfterPrepare(h, trigger.id);
      const start = h.mint.requests.length;
      await expect(h.coco.ops.mint.execute(prepared.id)).rejects.toThrow(
        'cannot issue new outputs',
      );
      expect((await h.coco.ops.mint.get(prepared.id))?.state).toBe('pending');
      expect(paths(h, start)).toEqual([]);
    },
  );

  it.each([
    ['pre-swap', 8, 0, true],
    ['direct payment with change', 16, 13, false],
  ] as const)(
    'keeps a prepared Melt cancellable after rotation before %s',
    async (_label, funding, reserve, needsSwap) => {
      const h = await setup();
      await fund(h, 'trigger', 8);
      const trigger = await h.coco.ops.send.prepare({ mintUrl, amount: 3 });
      await fund(h, 'melt-input', funding);
      await storeMeltQuote(h, reserve);
      const prepared = await h.coco.ops.melt.prepare({
        quote: { mintUrl, method: 'bolt11', quoteId: 'melt' },
      });
      expect(prepared.needsSwap).toBe(needsSwap);
      if (!needsSwap) expect(prepared.changeOutputData.keep.length).toBeGreaterThan(0);
      await rotateAfterPrepare(h, trigger.id);
      const start = h.mint.requests.length;
      await expect(h.coco.ops.melt.execute(prepared.id)).rejects.toThrow(
        'cannot issue new outputs',
      );
      expect(await h.coco.ops.melt.get(prepared.id)).toEqual(prepared);
      await h.coco.ops.melt.cancel(prepared.id);
      expect(paths(h, start)).toEqual([]);
    },
  );

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
    expect(paths(sender, start)).toEqual(['/v1/swap', ...metadataRefresh]);
  });

  it('defers a Melt whose pre-swap the mint rejects and reports the mint error', async () => {
    const h = await setup();
    await fund(h, 'fund', 8);
    await storeMeltQuote(h);
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
    expect(paths(h, start)).toEqual(['/v1/swap', ...metadataRefresh]);
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
      ...metadataRefresh,
    ]);

    // Operation Recovery replays the same request; its rejection is followed by a refresh too.
    h.mint.mintRejections.push(keysetInactive);
    const recoveryStart = h.mint.requests.length;
    expect((await h.coco.ops.mint.refresh(operation.id)).state).toBe('executing');
    expect(paths(h, recoveryStart)).toEqual([
      '/v1/mint/quote/bolt11/q',
      '/v1/mint/bolt11',
      ...metadataRefresh,
    ]);
  });

  it('refreshes when only the replay after a failed submission is rejected for its keyset', async () => {
    const h = await setup();
    await h.quote({ quote: 'q', method: 'bolt11', amount: 8, amountPaid: 8 });
    const operation = await h.coco.ops.mint.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: 'q' },
      amount: 8,
    });
    const outputsPending = { code: 11004, detail: 'Outputs are pending' };
    // The submission, then the replay that execute() attempts after it.
    h.mint.mintRejections.push(outputsPending, keysetInactive);
    const start = h.mint.requests.length;

    const error = await h.coco.ops.mint.execute(operation.id).catch((caught: unknown) => caught);

    expectMintError(error, outputsPending.code);
    expect((await h.coco.ops.mint.get(operation.id))?.state).toBe('executing');
    expect(paths(h, start)).toEqual([
      '/v1/mint/bolt11',
      '/v1/mint/quote/bolt11/q',
      '/v1/mint/bolt11',
      ...metadataRefresh,
    ]);
  });

  it('fails a Batch Mint Operation on the definitive code 12002', async () => {
    const h = await setup();
    for (const quote of ['a', 'b'])
      await h.quote({ quote, method: 'bolt11', amount: 8, amountPaid: 8 });
    h.mint.batchBehaviors.push(keysetInactive);
    const start = h.mint.requests.length;

    const operation = await h.coco.ops.mint.batch.execute({
      mintUrl,
      method: 'bolt11',
      members: [{ quoteId: 'a' }, { quoteId: 'b' }],
    });

    expect(operation.state === 'failed' && operation.terminalFailure.code).toBe('12002');
    expect(paths(h, start)).toEqual(['/v1/mint/bolt11/batch', ...metadataRefresh]);
  });

  it('stays off a v3 keyset the mint advertises after it rejects a Melt pre-swap', async () => {
    const v3KeysetId = `02${'00'.repeat(32)}`;
    const mint = new FakeBatchMint();
    mint.install();
    installed = mint;
    let walletService: WalletService | undefined;
    const plugin: Plugin<['walletService']> = {
      name: 'wallet-service-probe',
      required: ['walletService'],
      onReady: ({ services }) => {
        walletService = services.walletService;
      },
    };
    const h = await createBatchMintHarness({ mint, plugins: [plugin] });
    harnesses.push(h);
    await fund(h, 'fund', 8);
    await storeMeltQuote(h);
    const prepared = await h.coco.ops.melt.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: 'melt' },
    });
    // The pre-swap runs on the Wallet Service's cached Wallet Instance.
    const { wallet: used } = await walletService!.getWalletWithActiveKeysetId(mintUrl, 'sat');
    // The mint rotates to a v3 keyset, newer and as cheap as the current one.
    mint.advertisedKeysets.push({ id: v3KeysetId, unit: 'sat', active: true, input_fee_ppk: 0 });
    mint.swapRejections.push(keysetInactive);

    expectMintError(await h.coco.ops.melt.execute(prepared.id).catch((caught: unknown) => caught));

    expect(used.keyChain.hasKeyset(v3KeysetId)).toBe(false);
    const { wallet, keysetId } = await walletService!.getWalletWithActiveKeysetId(mintUrl, 'sat');
    expect(wallet).not.toBe(used);
    expect(keysetId).toBe(mint.keysetId('sat'));
    expect(wallet.keyChain.hasKeyset(v3KeysetId)).toBe(false);
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

describe('BOLT11 quote amount', () => {
  let h: BatchMintHarness;

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  it('refuses an unlocked quote the mint creates for another amount than requested', async () => {
    const mint = new FakeBatchMint();
    mint.nut20 = false;
    mint.createdQuoteAmount = 11;
    mint.install();
    h = await createBatchMintHarness({ mint });

    await expect(
      h.coco.quotes.mint.create({ mintUrl: mint.mintUrl, method: 'bolt11', amount: 10 }),
    ).rejects.toThrow('Mint returned a BOLT11 quote for a different amount');
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
