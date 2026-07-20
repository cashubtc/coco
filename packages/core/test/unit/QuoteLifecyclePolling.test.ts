import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/melt/index.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/index.ts';
import { HttpResponseError, MintOperationError, NetworkError } from '../../models/Error.ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
  type MintQuote,
} from '../../models/MintQuote.ts';
import type { ProofRepository } from '../../repositories/index.ts';
import { MemoryKeysetRepository } from '../../repositories/memory/MemoryKeysetRepository.ts';
import { MemoryMintQuoteRepository } from '../../repositories/memory/MemoryMintQuoteRepository.ts';
import { MemoryMintRepository } from '../../repositories/memory/MemoryMintRepository.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';

const mintUrl = 'https://mint.test';
const expiry = Math.floor(Date.now() / 1000) + 3600;

describe('QuoteLifecycle mint quote polling', () => {
  let eventBus: EventBus<CoreEvents>;
  let mintAdapter: MintAdapter;
  let mintQuoteRepository: MemoryMintQuoteRepository;
  let mintRepository: MemoryMintRepository;
  let quoteLifecycle: QuoteLifecycle;
  let fetchRemoteMintQuote: ReturnType<typeof mock>;

  beforeEach(async () => {
    eventBus = new EventBus<CoreEvents>();
    mintQuoteRepository = new MemoryMintQuoteRepository();
    mintAdapter = {
      checkMintQuoteBatch: mock(async () => []),
      checkMintQuote: mock(async (_mintUrl: string, _method: string, quoteId: string) => ({
        quote: quoteId,
        request: `lnbc1${quoteId}`,
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      })),
    } as unknown as MintAdapter;

    mintRepository = new MemoryMintRepository();
    await mintRepository.addOrUpdateMint({
      mintUrl,
      name: 'test mint',
      trusted: true,
      createdAt: 0,
      updatedAt: Math.floor(Date.now() / 1000),
      mintInfo: {
        nuts: {
          '4': {
            methods: [
              { method: 'bolt11', unit: 'sat' },
              { method: 'bolt12', unit: 'sat' },
              { method: 'onchain', unit: 'sat' },
            ],
            disabled: false,
          },
          '29': { methods: ['bolt11', 'bolt12', 'onchain'], max_batch_size: 100 },
        },
      } as never,
    });
    const mintService = new MintService(mintRepository, new MemoryKeysetRepository(), mintAdapter);
    fetchRemoteMintQuote = mock(async ({ quote }: { quote: MintQuote<'bolt11'> }) =>
      mintQuoteFromBolt11Response(quote.mintUrl, {
        quote: quote.quoteId,
        request: quote.request,
        amount: quote.amount,
        unit: quote.unit,
        expiry: quote.expiry,
        state: 'PAID',
      }),
    );
    const mintHandlerProvider = {
      get: mock(() => ({ fetchRemoteQuote: fetchRemoteMintQuote })),
    } as unknown as MintHandlerProvider;

    quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider,
      meltHandlerProvider: {} as MeltHandlerProvider,
      mintQuoteRepository,
      meltQuoteRepository: {} as never,
      proofRepository: {} as ProofRepository,
      proofService: {} as ProofService,
      mintService,
      walletService: {} as WalletService,
      mintAdapter,
      eventBus,
    });
  });

  async function persistBolt11Quote(quoteId: string): Promise<void> {
    await mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Response(mintUrl, {
        quote: quoteId,
        request: `lnbc1${quoteId}`,
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'UNPAID',
      }),
    );
  }

  async function persistBolt12Quote(quoteId: string): Promise<void> {
    await mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt12Response(mintUrl, {
        quote: quoteId,
        request: `lno1${quoteId}`,
        amount: Amount.from(12),
        unit: 'sat',
        expiry,
        pubkey: '02'.padEnd(66, '2'),
        amount_paid: Amount.zero(),
        amount_issued: Amount.zero(),
      }),
    );
  }

  async function persistOnchainQuote(quoteId: string): Promise<void> {
    await mintQuoteRepository.upsertMintQuote(
      mintQuoteFromOnchainResponse(mintUrl, {
        quote: quoteId,
        request: `bc1q${quoteId}`,
        unit: 'sat',
        expiry,
        pubkey: '02'.padEnd(66, '3'),
        amount_paid: Amount.zero(),
        amount_issued: Amount.zero(),
      }),
    );
  }

  async function setNut29Methods(methods: string[] | undefined): Promise<void> {
    const mint = await mintRepository.getMintByUrl(mintUrl);
    if (!mint) throw new Error('Expected test mint');
    await mintRepository.addOrUpdateMint({
      ...mint,
      updatedAt: Math.floor(Date.now() / 1000),
      mintInfo: {
        nuts: {
          '4': {
            methods: [
              { method: 'bolt11', unit: 'sat' },
              { method: 'bolt12', unit: 'sat' },
              { method: 'onchain', unit: 'sat' },
            ],
            disabled: false,
          },
          '29': {
            ...(methods === undefined ? {} : { methods }),
            max_batch_size: 100,
          },
        },
      } as never,
    });
  }

  it('matches reordered BOLT11 observations by identity and persists before events', async () => {
    await persistBolt11Quote('quote-a');
    await persistBolt11Quote('quote-b');
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        quote: 'quote-b',
        request: 'lnbc1quote-b',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
      {
        quote: 'quote-a',
        request: 'lnbc1quote-a',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
    ]);
    const persistedDuringEvents: Array<MintQuote | null> = [];
    eventBus.on('mint-quote:updated', async ({ quote }) => {
      persistedDuringEvents.push(
        await mintQuoteRepository.getMintQuote(quote.mintUrl, quote.method, quote.quoteId),
      );
    });

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
      { mintUrl, quoteId: 'quote-b' },
    ]);

    expect(result.outcomes.map((outcome) => [outcome.identity.quoteId, outcome.status])).toEqual([
      ['quote-a', 'updated'],
      ['quote-b', 'updated'],
    ]);
    expect(result.responseFailures).toEqual([]);
    expect(persistedDuringEvents.map((quote) => quote?.method === 'bolt11' && quote.state)).toEqual(
      ['PAID', 'PAID'],
    );
  });

  it('retains attributable observations while reporting missing, duplicate, and extra identities', async () => {
    await persistBolt11Quote('quote-a');
    await persistBolt11Quote('quote-b');
    await persistBolt11Quote('quote-c');
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        quote: 'quote-a',
        request: 'lnbc1quote-a',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
      {
        quote: 'quote-c',
        request: 'lnbc1quote-c',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'UNPAID',
      },
      {
        quote: 'quote-c',
        request: 'lnbc1quote-c',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
      {
        quote: 'extra-quote',
        request: 'lnbc1extra',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
      { request: 'identity-less' },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
      { mintUrl, quoteId: 'quote-b' },
      { mintUrl, quoteId: 'quote-c' },
    ]);

    expect(
      result.outcomes.map((outcome) => [
        outcome.identity.quoteId,
        outcome.status,
        outcome.status === 'failed' ? outcome.failure.category : undefined,
      ]),
    ).toEqual([
      ['quote-a', 'updated', undefined],
      ['quote-b', 'failed', 'malformed-response'],
      ['quote-c', 'failed', 'malformed-response'],
    ]);
    expect(result.responseFailures.map((failure) => failure.responseQuoteId)).toEqual([
      'extra-quote',
      undefined,
    ]);
    expect(result.responseFailures.every(({ category }) => category === 'malformed-response')).toBe(
      true,
    );
    await expect(
      mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote-a'),
    ).resolves.toMatchObject({ state: 'PAID' });
    await expect(
      mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote-b'),
    ).resolves.toMatchObject({ state: 'UNPAID' });
    await expect(
      mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', 'quote-c'),
    ).resolves.toMatchObject({ state: 'UNPAID' });
  });

  it('retains one attributable observation from identical and partly malformed duplicates', async () => {
    await persistBolt11Quote('quote-a');
    await persistBolt11Quote('quote-b');
    const validA = {
      quote: 'quote-a',
      request: 'lnbc1quote-a',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      state: 'PAID',
    };
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce([
      validA,
      { ...validA },
      {
        quote: 'quote-b',
        request: 'lnbc1quote-b',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
      {
        quote: 'quote-b',
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
      { mintUrl, quoteId: 'quote-b' },
    ]);

    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['updated', 'updated']);
    expect(result.responseFailures).toHaveLength(2);
    expect(result.responseFailures.map((failure) => failure.responseQuoteId)).toEqual([
      'quote-a',
      'quote-b',
    ]);
    expect(result.responseFailures.map((failure) => failure.category)).toEqual([
      'malformed-response',
      'validation',
    ]);
  });

  it('normalizes units when identifying equivalent duplicate observations', async () => {
    await persistBolt11Quote('quote-a');
    const valid = {
      quote: 'quote-a',
      request: 'lnbc1quote-a',
      amount: Amount.from(10),
      unit: 'sat',
      expiry,
      state: 'PAID',
    };
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce([
      valid,
      { ...valid, unit: 'SAT' },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
    ]);

    expect(result.outcomes[0]).toMatchObject({ status: 'updated' });
    expect(result.responseFailures).toHaveLength(1);
    expect(result.responseFailures[0]).toMatchObject({
      category: 'malformed-response',
      responseQuoteId: 'quote-a',
    });
  });

  it('records attributable BOLT12 and on-chain observations', async () => {
    await persistBolt12Quote('bolt12-quote');
    await persistOnchainQuote('onchain-quote');
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>)
      .mockResolvedValueOnce([
        {
          quote: 'bolt12-quote',
          request: 'lno1bolt12-quote',
          amount: Amount.from(12),
          unit: 'sat',
          expiry,
          pubkey: '02'.padEnd(66, '2'),
          amount_paid: Amount.from(20),
          amount_issued: Amount.from(8),
        },
      ])
      .mockResolvedValueOnce([
        {
          quote: 'onchain-quote',
          request: 'bc1qonchain-quote',
          unit: 'sat',
          expiry,
          pubkey: '02'.padEnd(66, '3'),
          amount_paid: Amount.from(30),
          amount_issued: Amount.from(9),
        },
      ]);

    const bolt12 = await quoteLifecycle.checkMintQuotesForPolling('bolt12', [
      { mintUrl, quoteId: 'bolt12-quote' },
    ]);
    const onchain = await quoteLifecycle.checkMintQuotesForPolling('onchain', [
      { mintUrl, quoteId: 'onchain-quote' },
    ]);

    expect(bolt12.outcomes[0]?.status).toBe('updated');
    expect(onchain.outcomes[0]?.status).toBe('updated');
    const storedBolt12 = await mintQuoteRepository.getMintQuote(mintUrl, 'bolt12', 'bolt12-quote');
    const storedOnchain = await mintQuoteRepository.getMintQuote(
      mintUrl,
      'onchain',
      'onchain-quote',
    );
    expect(storedBolt12?.reusable && storedBolt12.quoteData.amountPaid.toString()).toBe('20');
    expect(storedOnchain?.reusable && storedOnchain.quoteData.amountPaid.toString()).toBe('30');
  });

  it('rejects canonical identity conflicts and over-issued reusable observations', async () => {
    await persistBolt12Quote('bolt12-conflict');
    await persistOnchainQuote('onchain-over-issued');
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>)
      .mockResolvedValueOnce([
        {
          quote: 'bolt12-conflict',
          request: 'different-request',
          amount: Amount.from(12),
          unit: 'sat',
          expiry,
          pubkey: '02'.padEnd(66, '2'),
          amount_paid: Amount.from(20),
          amount_issued: Amount.from(8),
        },
      ])
      .mockResolvedValueOnce([
        {
          quote: 'onchain-over-issued',
          request: 'bc1qonchain-over-issued',
          unit: 'sat',
          expiry,
          pubkey: '02'.padEnd(66, '3'),
          amount_paid: Amount.from(10),
          amount_issued: Amount.from(11),
        },
      ]);

    const conflict = await quoteLifecycle.checkMintQuotesForPolling('bolt12', [
      { mintUrl, quoteId: 'bolt12-conflict' },
    ]);
    const overIssued = await quoteLifecycle.checkMintQuotesForPolling('onchain', [
      { mintUrl, quoteId: 'onchain-over-issued' },
    ]);

    expect(conflict.outcomes[0]).toMatchObject({
      status: 'failed',
      failure: { category: 'validation' },
    });
    expect(overIssued.outcomes[0]).toMatchObject({
      status: 'failed',
      failure: { category: 'validation' },
    });
    const storedConflict = await mintQuoteRepository.getMintQuote(
      mintUrl,
      'bolt12',
      'bolt12-conflict',
    );
    const storedOverIssued = await mintQuoteRepository.getMintQuote(
      mintUrl,
      'onchain',
      'onchain-over-issued',
    );
    expect(storedConflict?.request).toBe('lno1bolt12-conflict');
    expect(storedOverIssued?.reusable && storedOverIssued.quoteData.amountIssued.toString()).toBe(
      '0',
    );
  });

  it('classifies request-wide polling failures without losing the original error', async () => {
    await persistBolt11Quote('quote-a');
    await persistBolt11Quote('quote-b');
    const cases = [
      ['network', new NetworkError('offline')],
      ['authentication', new HttpResponseError('authentication required', 401)],
      ['authentication', new MintOperationError(30_001, 'blind auth required')],
      ['rate-limit', new HttpResponseError('slow down', 429)],
      ['rate-limit', new MintOperationError(31_004, 'BAT mint rate limit exceeded')],
      ['server', new HttpResponseError('unavailable', 503)],
      ['incompatibility', new HttpResponseError('not implemented', 405)],
      ['batch-size', new MintOperationError(11_017, 'batch too large')],
      ['malformed-response', new HttpResponseError('bad response', 200)],
      ['validation', new MintOperationError(20_002, 'quote state conflict')],
    ] as const;

    for (const [category, error] of cases) {
      (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockRejectedValueOnce(error);

      const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
        { mintUrl, quoteId: 'quote-a' },
        { mintUrl, quoteId: 'quote-b' },
      ]);

      expect(result.outcomes).toHaveLength(2);
      for (const outcome of result.outcomes) {
        expect(outcome.status).toBe('failed');
        if (outcome.status !== 'failed') throw new Error('Expected a failed polling outcome');
        expect(outcome.failure.category).toBe(category);
        expect(outcome.failure.error).toBe(error);
      }
      expect(result.responseFailures).toEqual([]);
    }
  });

  it('classifies wrapped mint-info refresh failures by their transport cause', async () => {
    await persistBolt11Quote('quote-a');
    const mint = await mintRepository.getMintByUrl(mintUrl);
    if (!mint) throw new Error('Expected test mint');
    await mintRepository.addOrUpdateMint({ ...mint, updatedAt: 0 });
    const cases = [
      ['network', new NetworkError('offline')],
      ['authentication', new HttpResponseError('authentication required', 401)],
      ['rate-limit', new HttpResponseError('slow down', 429)],
      ['server', new HttpResponseError('unavailable', 503)],
    ] as const;

    for (const [category, cause] of cases) {
      mintAdapter.fetchMintInfo = mock(async () => {
        throw cause;
      });

      const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
        { mintUrl, quoteId: 'quote-a' },
      ]);

      expect(result.outcomes[0]).toMatchObject({
        status: 'failed',
        failure: { category },
      });
      const outcome = result.outcomes[0]!;
      if (outcome.status !== 'failed') throw new Error('Expected a failed polling outcome');
      expect((outcome.failure.error as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });

  it('returns malformed-response outcomes when the batch response is not an array', async () => {
    await persistBolt11Quote('quote-a');
    await persistBolt11Quote('quote-b');
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce({
      quotes: [],
    });

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
      { mintUrl, quoteId: 'quote-b' },
    ]);

    expect(
      result.outcomes.map((outcome) =>
        outcome.status === 'failed' ? outcome.failure.category : outcome.status,
      ),
    ).toEqual(['malformed-response', 'malformed-response']);
    expect(result.responseFailures).toEqual([]);
  });

  it('uses one single polling check when NUT-29 does not advertise the method', async () => {
    await persistBolt11Quote('quote-a');
    await setNut29Methods(['bolt12']);

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
    ]);

    expect(result.outcomes[0]?.status).toBe('updated');
    expect(mintAdapter.checkMintQuote).toHaveBeenCalledWith(mintUrl, 'bolt11', 'quote-a');
    expect(mintAdapter.checkMintQuoteBatch).not.toHaveBeenCalled();
  });

  it('treats omitted NUT-29 methods as support for NUT-04 methods', async () => {
    await persistBolt11Quote('quote-a');
    await setNut29Methods(undefined);
    (mintAdapter.checkMintQuoteBatch as ReturnType<typeof mock>).mockResolvedValueOnce([
      {
        quote: 'quote-a',
        request: 'lnbc1quote-a',
        amount: Amount.from(10),
        unit: 'sat',
        expiry,
        state: 'PAID',
      },
    ]);

    const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', [
      { mintUrl, quoteId: 'quote-a' },
    ]);

    expect(result.outcomes[0]?.status).toBe('updated');
    expect(mintAdapter.checkMintQuoteBatch).toHaveBeenCalledWith(mintUrl, 'bolt11', ['quote-a']);
    expect(mintAdapter.checkMintQuote).not.toHaveBeenCalled();
  });

  it('keeps explicit quote refresh on the existing single-quote handler path', async () => {
    await persistBolt11Quote('quote-a');

    const refreshed = await quoteLifecycle.refreshMintQuoteById({ mintUrl, quoteId: 'quote-a' });

    expect(refreshed.method === 'bolt11' && refreshed.state).toBe('PAID');
    expect(fetchRemoteMintQuote).toHaveBeenCalledTimes(1);
    expect(mintAdapter.checkMintQuoteBatch).not.toHaveBeenCalled();
  });

  it('rejects mixed-mint and duplicate selections before making a polling request', async () => {
    const selections = [
      [
        { mintUrl, quoteId: 'quote-a' },
        { mintUrl: 'https://other-mint.test', quoteId: 'quote-b' },
      ],
      [
        { mintUrl, quoteId: 'quote-a' },
        { mintUrl: `${mintUrl}/`, quoteId: 'quote-a' },
      ],
    ];

    for (const identities of selections) {
      const result = await quoteLifecycle.checkMintQuotesForPolling('bolt11', identities);

      expect(result.outcomes).toHaveLength(2);
      expect(
        result.outcomes.every(
          (outcome) => outcome.status === 'failed' && outcome.failure.category === 'validation',
        ),
      ).toBe(true);
    }
    expect(mintAdapter.checkMintQuoteBatch).not.toHaveBeenCalled();
    expect(mintAdapter.checkMintQuote).not.toHaveBeenCalled();
  });
});
