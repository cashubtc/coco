import { Amount, PaymentRequest } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  initializeCoco,
  MemoryRepositories,
  OperationNotFoundError,
  OperationStateError,
  PaymentRequestError,
  type Manager,
} from '../../index.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
const unit = process.env.CUSTOM_UNIT ?? 'sat';
const sessions: Manager[] = [];
const originalFetch = globalThis.fetch;

async function session() {
  const repo = new MemoryRepositories();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
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
    requestRateLimit: { disabled: true },
  });
  sessions.push(coco);
  return { coco, repo };
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const coco of sessions.splice(0)) await coco.dispose();
});

// Core-only public error/parse contract coverage: no adapter schema or repository contract changes.
// Failure cases keep the real Manager, services and repositories and replace only HTTP transport.
describe('core prerequisite public contracts', () => {
  it('exports typed lookup errors through every operation API', async () => {
    const { coco } = await session();
    for (const operationType of ['mint', 'melt', 'send', 'receive'] as const) {
      const rejection = coco.ops[operationType].execute('missing');
      await expect(rejection).rejects.toBeInstanceOf(OperationNotFoundError);
      await expect(rejection).rejects.toMatchObject({
        operationType,
        operationId: 'missing',
        message: 'Operation missing not found',
      });
    }
  });

  it('preserves the decode cause in a public PaymentRequestError', async () => {
    const { coco } = await session();
    const rejection = coco.paymentRequests.parse('creqAnot-a-payment-request');
    await expect(rejection).rejects.toBeInstanceOf(PaymentRequestError);
    await expect(rejection).rejects.toMatchObject({
      message: 'Malformed encoded payment request',
      cause: expect.any(Error),
    });
  });

  it('publishes committed trust decisions when stale metadata cannot be refreshed', async () => {
    const { coco, repo } = await session();
    const staleTime = Math.floor(Date.now() / 1000) - 600;
    await repo.mintRepository.addNewMint({
      mintUrl,
      name: 'Offline mint',
      trusted: false,
      mintInfo: testMintInfo,
      createdAt: staleTime,
      updatedAt: staleTime,
    });
    const trustAtRequest: boolean[] = [];
    globalThis.fetch = (async (input, init) => {
      if (!String(input).startsWith(mintUrl)) return originalFetch(input, init);
      trustAtRequest.push(await coco.mint.isTrustedMint(mintUrl));
      throw new Error('mint offline');
    }) as typeof fetch;
    const published: { trusted: boolean; storedTrust: boolean; mintInfo: unknown }[] = [];
    coco.on('mint:updated', async ({ mint }) => {
      published.push({
        trusted: mint.trusted,
        storedTrust: await coco.mint.isTrustedMint(mintUrl),
        mintInfo: mint.mintInfo,
      });
    });

    for (const [trusted, change] of [
      [true, () => coco.mint.trustMint(mintUrl)],
      [false, () => coco.mint.untrustMint(mintUrl)],
      [true, () => coco.mint.addMint(mintUrl, { trusted: true })],
    ] as const) {
      trustAtRequest.length = 0;
      await change();
      expect(await coco.mint.isTrustedMint(mintUrl)).toBe(trusted);
      expect(trustAtRequest.length).toBeGreaterThan(0);
      expect(trustAtRequest.every((observed) => observed === trusted)).toBe(true);
    }
    expect(published).toEqual(
      [true, false, true].map((trusted) => ({
        trusted,
        storedTrust: trusted,
        mintInfo: testMintInfo,
      })),
    );
    await expect(coco.mint.addMint(`${mintUrl}/unknown`)).rejects.toThrow('Failed to fetch mint');
    expect(await coco.mint.getAllMints()).toHaveLength(1);
  });

  it.each(['PENDING', 'PAID'] as const)(
    'reports quoteState and retains Melt-owned proofs when reclaim observes %s',
    async (quoteState) => {
      const { coco, repo } = await session();
      const now = Math.floor(Date.now() / 1000);
      await repo.mintRepository.addNewMint({
        mintUrl,
        name: 'Pending mint',
        trusted: true,
        mintInfo: testMintInfo,
        createdAt: now,
        updatedAt: now,
      });
      const quoteId = 'pending-quote';
      const operationId = 'pending-melt';
      const secret = 'melt-owned-input';
      await repo.meltQuoteRepository.upsertMeltQuote({
        mintUrl,
        method: 'bolt11',
        quoteId,
        quote: quoteId,
        request: 'invoice',
        unit,
        amount: Amount.from(8),
        fee_reserve: Amount.zero(),
        expiry: now + 600,
        state: 'PENDING',
        createdAt: now,
        updatedAt: now,
      });
      await repo.meltOperationRepository.create({
        id: operationId,
        mintUrl,
        method: 'bolt11',
        methodData: { invoice: 'invoice' },
        quoteId,
        unit,
        state: 'pending',
        amount: Amount.from(8),
        fee_reserve: Amount.zero(),
        swap_fee: Amount.zero(),
        inputAmount: Amount.from(8),
        needsSwap: false,
        inputProofSecrets: [secret],
        changeOutputData: { keep: [], send: [] },
        createdAt: now,
        updatedAt: now,
      });
      await repo.proofRepository.saveProofs(mintUrl, [
        {
          id: testMintKeysetId(unit),
          mintUrl,
          unit,
          amount: Amount.from(8),
          C: testMintKeypairs['8'],
          secret,
          state: 'inflight',
          usedByOperationId: operationId,
        },
      ]);
      globalThis.fetch = (async (input) => {
        if (String(input) !== `${mintUrl}/v1/melt/quote/bolt11/${quoteId}`) {
          throw new Error(`Unexpected request: ${String(input)}`);
        }
        return Response.json({
          quote: quoteId,
          request: 'invoice',
          unit,
          amount: 8,
          fee_reserve: 0,
          expiry: now + 600,
          state: quoteState,
          payment_preimage: quoteState === 'PAID' ? 'preimage' : null,
          change: [],
        });
      }) as typeof fetch;
      const rejection = coco.ops.melt.reclaim(operationId);
      await expect(rejection).rejects.toBeInstanceOf(OperationStateError);
      await expect(rejection).rejects.toMatchObject({
        operationType: 'melt',
        operationId,
        state: 'pending',
        expectedStates: ['prepared', 'pending'],
        quoteState,
      });
      expect((await coco.ops.melt.get(operationId))?.state).toBe('pending');
      expect((await coco.quotes.melt.get({ mintUrl, quoteId }))?.state).toBe(quoteState);
      expect(await repo.proofRepository.getProofsBySecrets(mintUrl, [secret])).toMatchObject([
        { secret, state: 'inflight', usedByOperationId: operationId },
      ]);
    },
  );

  it('filters an amountless request by its intended amount and pays the receiver net target', async () => {
    const { coco: payer } = await session();
    const { coco: receiver } = await session();
    await payer.mint.addMint(mintUrl, { trusted: true });
    const quote = await payer.quotes.mint.create({
      mintUrl,
      method: 'bolt11',
      amount: { amount: 64, unit },
    });
    const mint = await payer.ops.mint.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
      amount: 64,
    });
    let minted = await payer.ops.mint.execute(mint.id);
    for (let attempt = 0; minted.state !== 'finalized' && attempt < 30; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      minted = await payer.ops.mint.refresh(mint.id);
      if (minted.state === 'pending') minted = await payer.ops.mint.execute(mint.id);
    }
    expect(minted.state).toBe('finalized');
    await expect(payer.ops.mint.checkPayment(mint.id)).rejects.toMatchObject({
      name: 'OperationStateError',
      operationType: 'mint',
      operationId: mint.id,
      state: 'finalized',
      expectedStates: ['pending'],
    });

    const encoded = new PaymentRequest([], 'amountless', undefined, unit, [
      mintUrl,
    ]).toEncodedRequest();
    expect((await payer.paymentRequests.parse(encoded)).payableMints).toEqual([mintUrl]);
    expect((await payer.paymentRequests.parse(encoded, { amount: 65 })).payableMints).toEqual([]);
    const parsed = await payer.paymentRequests.parse(encoded, { amount: 32 });
    expect(parsed.payableMints).toEqual([mintUrl]);
    expect(parsed.amount).toBeUndefined();
    expect(parsed.paymentRequest.amount).toBeUndefined();
    expect(parsed.unit).toBe(unit);
    await expect(
      payer.paymentRequests.parse(encoded, { amount: { amount: 32, unit: 'other' } }),
    ).rejects.toThrow();
    const fixed = new PaymentRequest([], 'fixed', 32, unit, [mintUrl]).toEncodedRequest();
    await expect(payer.paymentRequests.parse(fixed, { amount: 31 })).rejects.toBeInstanceOf(
      PaymentRequestError,
    );

    const prepared = await payer.paymentRequests.prepare(parsed, { mintUrl, amount: 32 });
    const paid = await payer.paymentRequests.execute(prepared);
    expect(paid.type).toBe('inband');
    if (paid.type !== 'inband') throw new Error('Expected in-band payment');
    const cancel = payer.ops.send.cancel(prepared.sendOperation.id);
    await expect(cancel).rejects.toBeInstanceOf(OperationStateError);
    await expect(cancel).rejects.toMatchObject({
      operationType: 'send',
      state: 'pending',
      expectedStates: ['prepared'],
    });
    await receiver.mint.addMint(mintUrl, { trusted: true });
    const received = await receiver.ops.receive.prepare({ token: paid.token });
    await receiver.ops.receive.execute(received.id);
    expect((await receiver.wallet.balances.byUnit())[unit]?.spendable).toEqual(Amount.from(32));
    await expect(receiver.ops.receive.cancel(received.id)).rejects.toMatchObject({
      name: 'OperationStateError',
      operationType: 'receive',
      state: 'finalized',
      expectedStates: ['init', 'prepared'],
    });
  }, 30000);
});
