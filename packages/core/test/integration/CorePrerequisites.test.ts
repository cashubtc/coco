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

/** Trusts the real mint and mints `amount` through a paid bolt11 Quote. Returns the Mint Operation ID. */
async function fund(coco: Manager, amount: number): Promise<string> {
  await coco.mint.addMint(mintUrl, { trusted: true });
  const quote = await coco.quotes.mint.create({
    mintUrl,
    method: 'bolt11',
    amount: { amount, unit },
  });
  const mint = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount,
  });
  let minted = await coco.ops.mint.execute(mint.id);
  for (let attempt = 0; minted.state !== 'finalized' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    minted = await coco.ops.mint.refresh(mint.id);
    if (minted.state === 'pending') minted = await coco.ops.mint.execute(mint.id);
  }
  expect(minted.state).toBe('finalized');
  return mint.id;
}

/** Stores a pending Melt whose Quote the mint still holds, with the proof the Melt owns. */
async function storePendingMelt(repo: MemoryRepositories) {
  const now = Math.floor(Date.now() / 1000);
  const quoteId = 'pending-quote';
  const operationId = 'pending-melt';
  const secret = 'melt-owned-input';
  await repo.mintRepository.addNewMint({
    mintUrl,
    name: 'Pending mint',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: now,
    updatedAt: now,
  });
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
  return { quoteId, operationId, secret, expiry: now + 600 };
}

/** Answers the mint's Melt Quote check with `state`, and fails any other request. */
function answerMeltQuoteChecks(
  quote: { quoteId: string; expiry: number },
  state: 'PENDING' | 'PAID',
) {
  globalThis.fetch = (async (input) => {
    if (String(input) !== `${mintUrl}/v1/melt/quote/bolt11/${quote.quoteId}`) {
      throw new Error(`Unexpected request: ${String(input)}`);
    }
    return Response.json({
      quote: quote.quoteId,
      request: 'invoice',
      unit,
      amount: 8,
      fee_reserve: 0,
      expiry: quote.expiry,
      state,
      payment_preimage: state === 'PAID' ? 'preimage' : null,
      change: [],
    });
  }) as typeof fetch;
}

/** Asserts a typed state rejection that names what was observed and what the command accepts. */
async function expectStateRejection(
  command: Promise<unknown>,
  details: {
    operationType: 'mint' | 'melt' | 'send' | 'receive';
    operationId: string;
    state: string;
    expectedStates: string[];
    quoteState?: string;
  },
) {
  await expect(command).rejects.toBeInstanceOf(OperationStateError);
  await expect(command).rejects.toMatchObject(details);
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const coco of sessions.splice(0)) await coco.dispose();
});

// Core-only public error/parse contract coverage: no adapter schema or repository contract changes.
// Every case drives the real Manager, services and repositories. Workflows run against the real
// mint; states the mint cannot produce on demand are stored directly or replace only HTTP transport.
describe('core prerequisite public contracts', () => {
  it('rejects every lifecycle command that targets a missing Operation with a typed lookup error', async () => {
    const { coco } = await session();
    const { mint, melt, send, receive } = coco.ops;
    const commands = {
      mint: [
        () => mint.execute('missing'),
        () => mint.checkPayment('missing'),
        () => mint.refresh('missing'),
        () => mint.finalize('missing'),
      ],
      melt: [
        () => melt.execute('missing'),
        () => melt.refresh('missing'),
        () => melt.cancel('missing'),
        () => melt.reclaim('missing'),
        () => melt.finalize('missing'),
      ],
      send: [
        () => send.execute('missing'),
        () => send.refresh('missing'),
        () => send.cancel('missing'),
        () => send.reclaim('missing'),
        () => send.finalize('missing'),
      ],
      receive: [
        () => receive.execute('missing'),
        () => receive.refresh('missing'),
        () => receive.cancel('missing'),
      ],
    } as const;

    for (const operationType of ['mint', 'melt', 'send', 'receive'] as const) {
      for (const command of commands[operationType]) {
        const rejection = command();
        await expect(rejection).rejects.toBeInstanceOf(OperationNotFoundError);
        await expect(rejection).rejects.toMatchObject({
          operationType,
          operationId: 'missing',
          message: 'Operation missing not found',
        });
      }
    }
  });

  it('reports the observed and accepted states when a Send, Receive or Mint command is unavailable', async () => {
    const { coco: payer } = await session();
    const { coco: receiver } = await session();
    const mintId = await fund(payer, 64);
    await receiver.mint.addMint(mintUrl, { trusted: true });

    await expectStateRejection(payer.ops.mint.checkPayment(mintId), {
      operationType: 'mint',
      operationId: mintId,
      state: 'finalized',
      expectedStates: ['pending'],
    });

    const prepared = await payer.ops.send.prepare({ mintUrl, amount: { amount: 8, unit } });
    await expectStateRejection(payer.ops.send.reclaim(prepared.id), {
      operationType: 'send',
      operationId: prepared.id,
      state: 'prepared',
      expectedStates: ['pending'],
    });
    await expectStateRejection(payer.ops.send.finalize(prepared.id), {
      operationType: 'send',
      operationId: prepared.id,
      state: 'prepared',
      expectedStates: ['pending'],
    });

    const { token } = await payer.ops.send.execute(prepared.id);
    for (const command of [
      () => payer.ops.send.execute(prepared.id),
      () => payer.ops.send.cancel(prepared.id),
    ]) {
      await expectStateRejection(command(), {
        operationType: 'send',
        operationId: prepared.id,
        state: 'pending',
        expectedStates: ['prepared'],
      });
    }

    const received = await receiver.ops.receive.prepare({ token });
    await receiver.ops.receive.execute(received.id);
    await expectStateRejection(receiver.ops.receive.execute(received.id), {
      operationType: 'receive',
      operationId: received.id,
      state: 'finalized',
      expectedStates: ['prepared'],
    });
    await expectStateRejection(receiver.ops.receive.cancel(received.id), {
      operationType: 'receive',
      operationId: received.id,
      state: 'finalized',
      expectedStates: ['init', 'prepared'],
    });

    // A P2PK Send passes the facade's pending check; its method cannot be reclaimed once executed.
    const recipient = await receiver.keyring.generateKeyPair();
    const locked = await payer.ops.send.prepare({
      mintUrl,
      amount: { amount: 4, unit },
      target: { type: 'p2pk', pubkey: recipient.publicKeyHex },
    });
    await payer.ops.send.execute(locked.id);
    await expectStateRejection(payer.ops.send.reclaim(locked.id), {
      operationType: 'send',
      operationId: locked.id,
      state: 'pending',
      expectedStates: ['prepared'],
    });
    expect((await payer.ops.send.get(locked.id))?.state).toBe('pending');
  }, 30000);

  it('reports the observed and accepted states when a Melt command is unavailable', async () => {
    const { coco } = await session();
    await fund(coco, 64);
    const invoice = await coco.quotes.mint.create({
      mintUrl,
      method: 'bolt11',
      amount: { amount: 8, unit },
    });
    const quote = await coco.quotes.melt.create({
      mintUrl,
      method: 'bolt11',
      methodData: { invoice: invoice.request },
      unit,
    });
    const melt = await coco.ops.melt.prepare({
      quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    });

    await expectStateRejection(coco.ops.melt.reclaim(melt.id), {
      operationType: 'melt',
      operationId: melt.id,
      state: 'prepared',
      expectedStates: ['pending'],
    });
    await expectStateRejection(coco.ops.melt.finalize(melt.id), {
      operationType: 'melt',
      operationId: melt.id,
      state: 'prepared',
      expectedStates: ['pending', 'executing'],
    });

    await coco.ops.melt.cancel(melt.id);
    for (const command of [
      () => coco.ops.melt.execute(melt.id),
      () => coco.ops.melt.cancel(melt.id),
    ]) {
      await expectStateRejection(command(), {
        operationType: 'melt',
        operationId: melt.id,
        state: 'rolled_back',
        expectedStates: ['prepared'],
      });
    }
  }, 30000);

  it('reports the stored state of a Mint Operation that an interrupted prepare left in init', async () => {
    const { coco, repo } = await session();
    const now = Date.now();
    const operationId = 'interrupted-mint';
    await repo.mintOperationRepository.create({
      id: operationId,
      state: 'init',
      mintUrl,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(8),
      unit,
      quoteId: 'interrupted-quote',
      createdAt: now,
      updatedAt: now,
    });

    for (const [command, expectedStates] of [
      [() => coco.ops.mint.execute(operationId), ['pending']],
      [() => coco.ops.mint.checkPayment(operationId), ['pending']],
      [() => coco.ops.mint.finalize(operationId), ['pending', 'executing']],
    ] as const) {
      await expectStateRejection(command(), {
        operationType: 'mint',
        operationId,
        state: 'init',
        expectedStates: [...expectedStates],
      });
    }
    expect((await coco.ops.mint.get(operationId))?.state).toBe('init');
  });

  it.each(['PENDING', 'PAID'] as const)(
    'reports quoteState and retains Melt-owned proofs when reclaim observes %s',
    async (quoteState) => {
      const { coco, repo } = await session();
      const melt = await storePendingMelt(repo);
      answerMeltQuoteChecks(melt, quoteState);

      await expectStateRejection(coco.ops.melt.reclaim(melt.operationId), {
        operationType: 'melt',
        operationId: melt.operationId,
        state: 'pending',
        expectedStates: ['prepared', 'pending'],
        quoteState,
      });
      expect((await coco.ops.melt.get(melt.operationId))?.state).toBe('pending');
      expect((await coco.quotes.melt.get({ mintUrl, quoteId: melt.quoteId }))?.state).toBe(
        quoteState,
      );
      expect(await repo.proofRepository.getProofsBySecrets(mintUrl, [melt.secret])).toMatchObject([
        { secret: melt.secret, state: 'inflight', usedByOperationId: melt.operationId },
      ]);
    },
  );

  it('reports quoteState and retains Melt-owned proofs when finalize observes an unsettled Quote', async () => {
    const { coco, repo } = await session();
    const melt = await storePendingMelt(repo);
    answerMeltQuoteChecks(melt, 'PENDING');

    await expectStateRejection(coco.ops.melt.finalize(melt.operationId), {
      operationType: 'melt',
      operationId: melt.operationId,
      state: 'pending',
      expectedStates: ['pending', 'executing'],
      quoteState: 'PENDING',
    });
    expect((await coco.ops.melt.get(melt.operationId))?.state).toBe('pending');
    expect(await repo.proofRepository.getProofsBySecrets(mintUrl, [melt.secret])).toMatchObject([
      { secret: melt.secret, state: 'inflight', usedByOperationId: melt.operationId },
    ]);
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

    // Without stored metadata there is no committed Known Mint to report, so the failure propagates.
    const unknownMintUrl = `${mintUrl}/unknown`;
    await expect(coco.mint.addMint(unknownMintUrl)).rejects.toThrow('Failed to fetch mint');
    await expect(coco.mint.trustMint(unknownMintUrl)).rejects.toThrow('Failed to fetch mint');
    expect(await coco.mint.getAllMints()).toHaveLength(1);
    expect(published).toHaveLength(3);
  });

  it('filters an amountless request by its intended amount and pays the receiver net target', async () => {
    const { coco: payer } = await session();
    const { coco: receiver } = await session();
    await fund(payer, 64);

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
    await receiver.mint.addMint(mintUrl, { trusted: true });
    const received = await receiver.ops.receive.prepare({ token: paid.token });
    await receiver.ops.receive.execute(received.id);
    expect((await receiver.wallet.balances.byUnit())[unit]?.spendable).toEqual(Amount.from(32));
  }, 30000);
});
