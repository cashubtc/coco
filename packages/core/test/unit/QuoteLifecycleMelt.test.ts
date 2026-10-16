import { Amount, type SerializedBlindedSignature } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { MeltHandlerProvider } from '../../infra/handlers/melt/index.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/index.ts';
import {
  meltQuoteFromBolt11Response,
  meltQuoteFromOnchainResponse,
  type MeltQuote,
} from '../../models/MeltQuote.ts';
import type { MeltQuoteRepository, MintQuoteRepository, ProofRepository } from '../../repositories';
import { MemoryMeltQuoteRepository } from '../../repositories/memory/MemoryMeltQuoteRepository.ts';
import { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';

const mintUrl = 'https://mint.test';
const change: SerializedBlindedSignature[] = [
  { id: 'keyset-1', amount: Amount.from(1), C_: '02'.padEnd(66, '1') },
];

describe('QuoteLifecycle Melt settlement observations', () => {
  let repository: MemoryMeltQuoteRepository;
  let lifecycle: QuoteLifecycle;
  let fetchRemoteQuote: ReturnType<typeof mock>;
  let updatedQuotes: MeltQuote[];

  beforeEach(() => {
    repository = new MemoryMeltQuoteRepository();
    updatedQuotes = [];
    fetchRemoteQuote = mock(async ({ quote }: { quote: MeltQuote }) => quote);
    const eventBus = new EventBus<CoreEvents>();
    eventBus.on('melt-quote:updated', ({ quote }) => {
      updatedQuotes.push(quote);
    });

    lifecycle = new QuoteLifecycle({
      mintHandlerProvider: {} as MintHandlerProvider,
      meltHandlerProvider: {
        get: mock(() => ({ fetchRemoteQuote })),
      } as unknown as MeltHandlerProvider,
      mintQuoteRepository: {} as MintQuoteRepository,
      meltQuoteRepository: repository as MeltQuoteRepository,
      proofRepository: {} as ProofRepository,
      proofService: {} as ProofService,
      mintService: {} as MintService,
      walletService: {} as WalletService,
      mintAdapter: {} as MintAdapter,
      eventBus,
    });
  });

  for (const state of ['UNPAID', 'PENDING'] as const) {
    it(`persists newer ${state} observation evidence without publishing a duplicate update`, async () => {
      const original = bolt11Quote({
        state,
        lastObservedRemoteState: state,
        lastObservedRemoteStateAt: 10,
        updatedAt: 10,
      });
      await repository.upsertMeltQuote(original);
      fetchRemoteQuote.mockResolvedValueOnce({
        ...original,
        lastObservedRemoteStateAt: 20,
        updatedAt: 20,
      });

      const refreshed = await lifecycle.refreshMeltQuote(mintUrl, 'bolt11', original.quoteId);
      expect(refreshed.lastObservedRemoteStateAt).toBe(20);
      expect(refreshed.createdAt).toBe(original.createdAt);
      expect(await repository.getMeltQuote(mintUrl, 'bolt11', original.quoteId)).toEqual(refreshed);

      const older = await lifecycle.recordMeltQuoteObservation({
        ...original,
        lastObservedRemoteStateAt: 15,
        updatedAt: 15,
      });
      expect(older.lastObservedRemoteStateAt).toBe(20);
      expect(older.updatedAt).toBe(refreshed.updatedAt);
      expect(updatedQuotes).toHaveLength(0);
    });
  }

  it('records fresh evidence for a legacy unchanged quote without observation metadata', async () => {
    const original = bolt11Quote({
      lastObservedRemoteState: undefined,
      lastObservedRemoteStateAt: undefined,
    });
    await repository.upsertMeltQuote(original);
    const recorded = await lifecycle.recordMeltQuoteObservation({
      ...original,
      lastObservedRemoteState: 'UNPAID',
      lastObservedRemoteStateAt: 20,
      updatedAt: 20,
    });
    expect(recorded.lastObservedRemoteState).toBe('UNPAID');
    expect(recorded.lastObservedRemoteStateAt).toBe(20);
    expect(updatedQuotes).toHaveLength(0);
  });

  it('does not downgrade a terminal PAID quote from a stale observation', async () => {
    await repository.upsertMeltQuote(
      bolt11Quote({ state: 'PAID', change, payment_preimage: 'preimage', updatedAt: 10 }),
    );

    const recorded = await lifecycle.recordMeltQuoteObservation(
      bolt11Quote({ state: 'PENDING', change: undefined, payment_preimage: null, updatedAt: 20 }),
    );

    expect(recorded.state).toBe('PAID');
    expect(recorded.change).toEqual(change);
    expect(recorded.method === 'bolt11' && recorded.payment_preimage).toBe('preimage');
    expect(updatedQuotes).toHaveLength(0);
  });

  it('does not let a concurrent unchanged UNPAID refresh overwrite PAID settlement', async () => {
    const original = bolt11Quote({ lastObservedRemoteStateAt: 10 });
    await repository.upsertMeltQuote(original);
    await Promise.all([
      lifecycle.recordMeltQuoteObservation({
        ...original,
        state: 'PAID',
        lastObservedRemoteState: 'PAID',
        lastObservedRemoteStateAt: 20,
        change,
        payment_preimage: 'preimage',
      }),
      lifecycle.recordMeltQuoteObservation({ ...original, lastObservedRemoteStateAt: 30 }),
    ]);
    const stored = await repository.getMeltQuote(mintUrl, 'bolt11', original.quoteId);
    expect(stored?.state).toBe('PAID');
    expect(stored?.lastObservedRemoteState).toBe('PAID');
    expect(stored?.change).toEqual(change);
    expect(updatedQuotes).toHaveLength(1);
  });

  it('refreshes and enriches an incomplete cached PAID BOLT settlement', async () => {
    const incomplete = bolt11Quote({
      state: 'PAID',
      change: undefined,
      payment_preimage: null,
      updatedAt: 10,
    });
    await repository.upsertMeltQuote(incomplete);
    const complete = bolt11Quote({
      state: 'PAID',
      change,
      payment_preimage: 'remote-preimage',
      updatedAt: 20,
    });
    fetchRemoteQuote.mockResolvedValueOnce(complete);

    const refreshed = await lifecycle.refreshMeltQuoteById({
      mintUrl,
      quoteId: incomplete.quoteId,
    });

    expect(fetchRemoteQuote).toHaveBeenCalledTimes(1);
    expect(refreshed.change).toEqual(change);
    expect(refreshed.method === 'bolt11' && refreshed.payment_preimage).toBe('remote-preimage');
    expect(updatedQuotes).toHaveLength(1);
  });

  it('enriches an incomplete cached PAID on-chain settlement with its outpoint', async () => {
    await repository.upsertMeltQuote(
      onchainQuote({ state: 'PAID', change: undefined, outpoint: undefined, updatedAt: 10 }),
    );

    const recorded = await lifecycle.recordMeltQuoteObservation(
      onchainQuote({ state: 'PAID', change, outpoint: 'txid:1', updatedAt: 20 }),
    );

    expect(recorded.change).toEqual(change);
    expect(recorded.method === 'onchain' && recorded.outpoint).toBe('txid:1');
    expect(updatedQuotes).toHaveLength(1);
  });

  it('does not replace an already complete PAID settlement with conflicting later data', async () => {
    const original = bolt11Quote({
      state: 'PAID',
      change,
      payment_preimage: 'original-preimage',
      updatedAt: 10,
    });
    await repository.upsertMeltQuote(original);
    const conflictingChange: SerializedBlindedSignature[] = [
      { id: 'keyset-2', amount: Amount.from(2), C_: '03'.padEnd(66, '2') },
    ];

    const recorded = await lifecycle.recordMeltQuoteObservation(
      bolt11Quote({
        state: 'PAID',
        change: conflictingChange,
        payment_preimage: 'conflicting-preimage',
        updatedAt: 20,
      }),
    );

    expect(recorded.change).toEqual(change);
    expect(recorded.method === 'bolt11' && recorded.payment_preimage).toBe('original-preimage');
    expect(updatedQuotes).toHaveLength(0);
  });
});

function bolt11Quote(overrides: Partial<MeltQuote<'bolt11'>> = {}): MeltQuote<'bolt11'> {
  return {
    ...meltQuoteFromBolt11Response(
      mintUrl,
      {
        quote: 'quote-bolt11',
        request: 'lnbc1invoice',
        amount: Amount.from(8),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9_999_999_999,
        state: 'UNPAID',
        payment_preimage: null,
      },
      { now: 1 },
    ),
    ...overrides,
  };
}

function onchainQuote(overrides: Partial<MeltQuote<'onchain'>> = {}): MeltQuote<'onchain'> {
  return {
    ...meltQuoteFromOnchainResponse(
      mintUrl,
      {
        quote: 'quote-onchain',
        request: 'bc1qaddress',
        amount: Amount.from(8),
        unit: 'sat',
        fee_options: [{ fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: 6 }],
        selected_fee_index: null,
        expiry: 9_999_999_999,
        state: 'UNPAID',
        outpoint: null,
      },
      { now: 1 },
    ),
    ...overrides,
  };
}
