import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/index.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/melt/index.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import {
  QuoteNotFoundError,
  QuoteWaitAbortedError,
  QuoteWaitTimeoutError,
  TerminalQuoteStateError,
} from '../../models/Error.ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromOnchainResponse,
  type MintQuote,
} from '../../models/MintQuote.ts';
import { meltQuoteFromBolt11Response, type MeltQuote } from '../../models/MeltQuote.ts';
import type {
  FetchRemoteMeltQuoteContext,
  MeltMethodHandler,
} from '../../operations/melt/MeltMethodHandler.ts';
import type {
  FetchRemoteMintQuoteContext,
  MintMethodHandler,
} from '../../operations/mint/MintMethodHandler.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import { MemoryMeltQuoteRepository } from '../../repositories/memory/MemoryMeltQuoteRepository.ts';
import { MemoryMintQuoteRepository } from '../../repositories/memory/MemoryMintQuoteRepository.ts';
import { MemoryProofRepository } from '../../repositories/memory/MemoryProofRepository.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

function listenerCount(eventBus: EventBus<CoreEvents>, event: keyof CoreEvents): number {
  const { listeners } = eventBus as unknown as {
    listeners: Map<keyof CoreEvents, Set<unknown>>;
  };
  return listeners.get(event)?.size ?? 0;
}

describe('QuoteLifecycle quote waiters', () => {
  let eventBus: EventBus<CoreEvents>;
  let mintQuoteRepository: MemoryMintQuoteRepository;
  let meltQuoteRepository: MemoryMeltQuoteRepository;
  let mintHandler: MintMethodHandler;
  let meltHandler: MeltMethodHandler;
  let quoteLifecycle: QuoteLifecycle;

  const makeBolt11MintQuote = (
    state: 'UNPAID' | 'PAID' | 'ISSUED' = 'UNPAID',
    overrides: Partial<MintQuote<'bolt11'>> = {},
  ): MintQuote<'bolt11'> =>
    mintQuoteFromBolt11Response(mintUrl, {
      quote: overrides.quoteId ?? quoteId,
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state,
      ...overrides,
    });

  const makeReusableMintQuote = (
    amountPaid: Amount,
    amountIssued: Amount,
    overrides: Partial<MintQuote<'onchain'>> = {},
  ): MintQuote<'onchain'> =>
    mintQuoteFromOnchainResponse(mintUrl, {
      quote: overrides.quoteId ?? quoteId,
      request: 'bc1ptest',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      amount_paid: amountPaid,
      amount_issued: amountIssued,
      ...overrides,
      pubkey: overrides.pubkey ?? '02'.padEnd(66, '1'),
    });

  const makeMeltQuote = (
    state: 'UNPAID' | 'PENDING' | 'PAID' = 'UNPAID',
    overrides: Partial<MeltQuote<'bolt11'>> = {},
  ): MeltQuote<'bolt11'> =>
    meltQuoteFromBolt11Response(mintUrl, {
      quote: overrides.quoteId ?? quoteId,
      request: 'lnbc1melt',
      amount: Amount.from(10),
      unit: 'sat',
      fee_reserve: Amount.from(1),
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state,
      payment_preimage: state === 'PAID' ? 'preimage' : null,
      ...overrides,
    });

  beforeEach(() => {
    eventBus = new EventBus<CoreEvents>();
    mintQuoteRepository = new MemoryMintQuoteRepository();
    meltQuoteRepository = new MemoryMeltQuoteRepository();

    mintHandler = {
      createQuote: mock(async () => makeBolt11MintQuote()),
      fetchRemoteQuote: mock(async ({ quote }) => quote),
      prepare: mock(async () => {
        throw new Error('not used');
      }),
      execute: mock(async () => {
        throw new Error('not used');
      }),
      recoverExecuting: mock(async () => {
        throw new Error('not used');
      }),
      checkPending: mock(async () => {
        throw new Error('not used');
      }),
    } as unknown as MintMethodHandler;

    meltHandler = {
      createQuote: mock(async ({ mintUrl: quoteMintUrl }) =>
        meltQuoteFromBolt11Response(quoteMintUrl, {
          quote: 'created-melt',
          request: 'lnbc1melt',
          amount: Amount.from(10),
          unit: 'sat',
          fee_reserve: Amount.from(1),
          expiry: Math.floor(Date.now() / 1000) + 3600,
          state: 'UNPAID',
          payment_preimage: null,
        }),
      ),
      fetchRemoteQuote: mock(async ({ quote }) => quote),
      prepare: mock(async () => {
        throw new Error('not used');
      }),
      execute: mock(async () => {
        throw new Error('not used');
      }),
      finalize: mock(async () => {
        throw new Error('not used');
      }),
      rollback: mock(async () => {}),
      checkPending: mock(async () => {
        throw new Error('not used');
      }),
      recoverExecuting: mock(async () => {
        throw new Error('not used');
      }),
    } as unknown as MeltMethodHandler;

    quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider: { get: mock(() => mintHandler) } as unknown as MintHandlerProvider,
      meltHandlerProvider: { get: mock(() => meltHandler) } as unknown as MeltHandlerProvider,
      mintQuoteRepository,
      meltQuoteRepository,
      proofRepository: new MemoryProofRepository(),
      proofService: {} as ProofService,
      mintService: {
        isTrustedMint: mock(async () => true),
        assertMethodUnitSupported: mock(async () => {}),
      } as unknown as MintService,
      walletService: {
        getWalletWithActiveKeysetId: mock(async () => ({ wallet: {} })),
      } as unknown as WalletService,
      mintAdapter: {} as MintAdapter,
      eventBus,
    });
  });

  it('rejects missing quote identities with typed errors', async () => {
    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId: 'missing' }),
    ).rejects.toThrow(QuoteNotFoundError);
    await expect(
      quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId: 'missing' }),
    ).rejects.toThrow(QuoteNotFoundError);
  });

  it('resolves mint claimability immediately for claimable BOLT11 and reusable quotes', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('PAID'));
    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId }),
    ).resolves.toMatchObject({
      state: 'PAID',
    });

    await mintQuoteRepository.upsertMintQuote(
      makeReusableMintQuote(Amount.from(7), Amount.from(2), { quoteId: 'reusable-claimable' }),
    );
    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId: 'reusable-claimable' }),
    ).resolves.toMatchObject({
      method: 'onchain',
      quoteId: 'reusable-claimable',
    });

    expect(mintHandler.fetchRemoteQuote).not.toHaveBeenCalled();
  });

  it('rejects mint claimability for issued or expired unclaimable quotes', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('ISSUED'));
    await expect(quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId })).rejects.toThrow(
      TerminalQuoteStateError,
    );

    await mintQuoteRepository.upsertMintQuote(
      makeReusableMintQuote(Amount.zero(), Amount.zero(), {
        quoteId: 'expired-empty',
        expiry: Math.floor(Date.now() / 1000) - 1,
      }),
    );
    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId: 'expired-empty' }),
    ).rejects.toThrow(TerminalQuoteStateError);
  });

  it('resolves expired reusable claimability when paid value remains unissued', async () => {
    await mintQuoteRepository.upsertMintQuote(
      makeReusableMintQuote(Amount.from(9), Amount.from(4), {
        expiry: Math.floor(Date.now() / 1000) - 1,
      }),
    );

    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId }),
    ).resolves.toMatchObject({
      method: 'onchain',
    });
  });

  it('waits for the next reusable mint payment beyond the baseline', async () => {
    await mintQuoteRepository.upsertMintQuote(
      makeReusableMintQuote(Amount.from(10), Amount.zero()),
    );

    const wait = quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId }, { timeoutMs: 100 });
    await nextTick();

    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'onchain', {
      quote: quoteId,
      request: 'bc1ptest',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(10),
      amount_issued: Amount.zero(),
    });
    await nextTick();

    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'onchain', {
      quote: quoteId,
      request: 'bc1ptest',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(11),
      amount_issued: Amount.zero(),
    });

    await expect(wait).resolves.toMatchObject({ quoteId, method: 'onchain' });
  });

  it('rejects next-payment waits when later reusable payment updates arrive after expiry', async () => {
    await mintQuoteRepository.upsertMintQuote(
      makeReusableMintQuote(Amount.from(10), Amount.zero()),
    );

    const wait = quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId }, { timeoutMs: 100 });
    await nextTick();

    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'onchain', {
      quote: quoteId,
      request: 'bc1ptest',
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) - 1,
      pubkey: '02'.padEnd(66, '1'),
      amount_paid: Amount.from(11),
      amount_issued: Amount.zero(),
    });

    await expect(wait).rejects.toThrow(TerminalQuoteStateError);
  });

  it('rejects next-payment waits for terminal BOLT11 quotes at call time', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('PAID'));

    await expect(quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId })).rejects.toThrow(
      TerminalQuoteStateError,
    );
  });

  it('resolves BOLT11 next-payment waits from later PAID or ISSUED updates', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('UNPAID'));

    const paidWait = quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId });
    await nextTick();
    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'bolt11', {
      quote: quoteId,
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'PAID',
    });
    await expect(paidWait).resolves.toMatchObject({ state: 'PAID' });

    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('UNPAID', { quoteId: 'issued' }));
    const issuedWait = quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId: 'issued' });
    await nextTick();
    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'bolt11', {
      quote: 'issued',
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) + 3600,
      state: 'ISSUED',
    });
    await expect(issuedWait).resolves.toMatchObject({ state: 'ISSUED' });
  });

  it('rejects BOLT11 next-payment waits when later paid updates arrive after expiry', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('UNPAID'));

    const wait = quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId }, { timeoutMs: 100 });
    await nextTick();

    await quoteLifecycle.recordMintQuoteSnapshot(mintUrl, 'bolt11', {
      quote: quoteId,
      request: 'lnbc1mint',
      amount: Amount.from(10),
      unit: 'sat',
      expiry: Math.floor(Date.now() / 1000) - 1,
      state: 'PAID',
    });

    await expect(wait).rejects.toThrow(TerminalQuoteStateError);
  });

  it('times out and aborts mint waits with typed errors and listener cleanup', async () => {
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('UNPAID'));

    await expect(
      quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId }, { timeoutMs: 1 }),
    ).rejects.toThrow(QuoteWaitTimeoutError);
    expect(listenerCount(eventBus, 'mint-quote:updated')).toBe(0);

    await expect(
      quoteLifecycle.awaitMintQuoteNextPayment({ mintUrl, quoteId }, { timeoutMs: 1 }),
    ).rejects.toThrow(QuoteWaitTimeoutError);
    expect(listenerCount(eventBus, 'mint-quote:updated')).toBe(0);

    const reason = new Error('screen closed');
    const controller = new AbortController();
    const wait = quoteLifecycle.awaitMintQuoteClaimable(
      { mintUrl, quoteId },
      { signal: controller.signal },
    );
    await nextTick();
    expect(listenerCount(eventBus, 'mint-quote:updated')).toBe(1);
    controller.abort(reason);

    await expect(wait).rejects.toThrow(QuoteWaitAbortedError);
    await expect(wait).rejects.toHaveProperty('cause', reason);
    expect(listenerCount(eventBus, 'mint-quote:updated')).toBe(0);
  });

  it('rejects mint waits with refresh failures and cleans up listeners', async () => {
    const refreshFailure = new Error('mint refresh failed');
    await mintQuoteRepository.upsertMintQuote(makeBolt11MintQuote('UNPAID'));
    mintHandler.fetchRemoteQuote = mock(async (_ctx: FetchRemoteMintQuoteContext) => {
      throw refreshFailure;
    }) as MintMethodHandler['fetchRemoteQuote'];

    const wait = quoteLifecycle.awaitMintQuoteClaimable({ mintUrl, quoteId });
    const rejection = expect(wait).rejects.toBe(refreshFailure);

    await rejection;
    expect(listenerCount(eventBus, 'mint-quote:updated')).toBe(0);
  });

  it('emits canonical melt quote update events after persistence on create and refresh', async () => {
    const seen: string[] = [];
    eventBus.on('melt-quote:updated', async ({ quote }) => {
      const stored = await meltQuoteRepository.getMeltQuote(
        quote.mintUrl,
        quote.method,
        quote.quoteId,
      );
      seen.push(`${quote.quoteId}:${stored?.state}`);
    });

    await quoteLifecycle.createMeltQuote(mintUrl, 'bolt11', { invoice: 'lnbc1melt' });
    await meltQuoteRepository.upsertMeltQuote(makeMeltQuote('UNPAID'));
    meltHandler.fetchRemoteQuote = mock(async ({ quote }: FetchRemoteMeltQuoteContext<'bolt11'>) =>
      makeMeltQuote('PAID', { quoteId: quote.quoteId }),
    ) as MeltMethodHandler['fetchRemoteQuote'];
    await quoteLifecycle.refreshMeltQuoteById({ mintUrl, quoteId });

    expect(seen).toEqual(['created-melt:UNPAID', 'quote-1:PAID']);
  });

  it('waits for melt quote PAID state and ignores non-paid updates', async () => {
    await meltQuoteRepository.upsertMeltQuote(makeMeltQuote('UNPAID'));

    const wait = quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId }, { timeoutMs: 100 });
    await nextTick();
    await eventBus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeMeltQuote('PENDING'),
    });
    await nextTick();
    await eventBus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeMeltQuote('PAID'),
    });

    await expect(wait).resolves.toMatchObject({ state: 'PAID' });
  });

  it('rejects melt waits when pending settlement returns to unpaid', async () => {
    await meltQuoteRepository.upsertMeltQuote(makeMeltQuote('UNPAID'));

    const wait = quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId }, { timeoutMs: 100 });
    await nextTick();
    await eventBus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeMeltQuote('PENDING'),
    });
    await nextTick();
    await eventBus.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId,
      quote: makeMeltQuote('UNPAID'),
    });

    await expect(wait).rejects.toThrow(TerminalQuoteStateError);
    await expect(wait).rejects.toHaveProperty('state', 'UNPAID');
    expect(listenerCount(eventBus, 'melt-quote:updated')).toBe(0);
  });

  it('rejects expired terminal-not-paid melt quotes', async () => {
    await meltQuoteRepository.upsertMeltQuote(
      makeMeltQuote('UNPAID', { expiry: Math.floor(Date.now() / 1000) - 1 }),
    );

    await expect(quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId })).rejects.toThrow(
      TerminalQuoteStateError,
    );
  });

  it('times out and aborts melt waits with typed errors and listener cleanup', async () => {
    await meltQuoteRepository.upsertMeltQuote(makeMeltQuote('UNPAID'));

    await expect(
      quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId }, { timeoutMs: 1 }),
    ).rejects.toThrow(QuoteWaitTimeoutError);
    expect(listenerCount(eventBus, 'melt-quote:updated')).toBe(0);

    const reason = new Error('screen closed');
    const controller = new AbortController();
    const wait = quoteLifecycle.awaitMeltQuoteSettlement(
      { mintUrl, quoteId },
      { signal: controller.signal },
    );
    await nextTick();
    expect(listenerCount(eventBus, 'melt-quote:updated')).toBe(1);
    controller.abort(reason);

    await expect(wait).rejects.toThrow(QuoteWaitAbortedError);
    await expect(wait).rejects.toHaveProperty('cause', reason);
    expect(listenerCount(eventBus, 'melt-quote:updated')).toBe(0);
  });

  it('rejects melt waits with refresh failures and cleans up listeners', async () => {
    const refreshFailure = new Error('melt refresh failed');
    await meltQuoteRepository.upsertMeltQuote(makeMeltQuote('UNPAID'));
    meltHandler.fetchRemoteQuote = mock(async (_ctx: FetchRemoteMeltQuoteContext) => {
      throw refreshFailure;
    }) as MeltMethodHandler['fetchRemoteQuote'];

    const wait = quoteLifecycle.awaitMeltQuoteSettlement({ mintUrl, quoteId });
    const rejection = expect(wait).rejects.toBe(refreshFailure);

    await rejection;
    expect(listenerCount(eventBus, 'melt-quote:updated')).toBe(0);
  });
});
