import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { MeltQuoteService } from '../../services/MeltQuoteService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MeltQuoteRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import { OutputData, type Proof } from '@cashu/cashu-ts';
import type { MeltQuote } from '../../models/MeltQuote';

describe('MeltQuoteService.payMeltQuote', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-123';

  let service: MeltQuoteService;
  let mockMintService: MintService;
  let mockProofService: ProofService;
  let mockWalletService: WalletService;
  let mockMeltQuoteRepo: MeltQuoteRepository;
  let eventBus: EventBus<CoreEvents>;
  let emittedEvents: Array<{ event: string; payload: any }>;

  const makeProof = (amount: number, secret: string): Proof =>
    ({
      amount: Amount.from(amount),
      secret,
      C: 'C_' as any,
      id: 'keyset-1',
    }) as Proof;

  beforeEach(() => {
    emittedEvents = [];
    eventBus = new EventBus<CoreEvents>();
    eventBus.on('melt-quote:paid', (payload) => {
      emittedEvents.push({ event: 'melt-quote:paid', payload });
    });
    eventBus.on('melt-quote:state-changed', (payload) => {
      emittedEvents.push({ event: 'melt-quote:state-changed', payload });
    });

    mockMintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
      assertMintMethodUnitSupported: mock(() => Promise.resolve()),
    } as any;

    mockMeltQuoteRepo = {
      async getMeltQuote() {
        return null;
      },
      async addMeltQuote() {},
      async setMeltQuoteState() {},
      async getPendingMeltQuotes() {
        return [];
      },
    } as MeltQuoteRepository;

    mockProofService = {
      async selectProofsToSend() {
        return [];
      },
      async setProofState() {},
      createOutputsAndIncrementCounters: mock(() =>
        Promise.resolve({
          keep: [],
          send: [],
          sendAmount: Amount.zero(),
          keepAmount: Amount.zero(),
        }),
      ),
      saveProofs: mock(() => Promise.resolve()),
    } as any;

    mockWalletService = {
      async getWalletWithActiveKeysetId() {
        return {
          wallet: {
            meltProofsBolt11: mock(() => Promise.resolve({ change: [], quote: {} as any })),
            send: mock(() => Promise.resolve({ send: [], keep: [] })),
            getFeesForProofs: mock(() => Amount.zero()), // Default mock for getFeesForProofs
          },
        };
      },
    } as any;

    service = new MeltQuoteService(
      mockMintService,
      mockProofService,
      mockWalletService,
      mockMeltQuoteRepo,
      eventBus,
      undefined,
    );
  });

  it('creates custom-unit melt quotes with a unit-scoped wallet and persisted unit', async () => {
    const quote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'USD',
      state: 'PENDING' as const,
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
    };
    const createMeltQuoteBolt11 = mock(async () => quote);
    const addMeltQuote = mock(async () => {});
    mockMeltQuoteRepo.addMeltQuote = addMeltQuote;
    mockWalletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet: { createMeltQuoteBolt11 },
      keysetId: 'keyset-1',
      keyset: { id: 'keyset-1', unit: 'usd', active: true },
      keys: { id: 'keyset-1', unit: 'usd', keys: { '1': 'pubkey' } as any },
    })) as any;

    const result = await service.createMeltQuote(mintUrl, 'lnbc110...', { unit: 'USD' });

    expect(mockMintService.assertMintMethodUnitSupported).toHaveBeenCalledWith(
      mintUrl,
      5,
      'bolt11',
      'usd',
    );
    expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
    expect(result.unit).toBe('usd');
    expect(addMeltQuote).toHaveBeenCalledWith(expect.objectContaining({ mintUrl, unit: 'usd' }));
  });

  it('should skip send/swap when selected proofs sum to exact amount', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const exactAmount = quote.amount.add(quote.fee_reserve); // 110
    const selectedProofs = [makeProof(110, 'secret-1')];

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));
    const setProofStateSpy = mock(() => Promise.resolve());
    mockProofService.setProofState = setProofStateSpy;
    const meltProofsBolt11Spy = mock(() => Promise.resolve({ change: [], quote: quote }));
    const getFeesForProofsSpy = mock(() => Amount.zero());

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      getFeesForProofs: getFeesForProofsSpy,
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() =>
      Promise.resolve({
        wallet,
        keysetId: 'keyset-1',
        keyset: { id: 'keyset-1', unit: 'sat', active: true },
        keys: { id: 'keyset-1', unit: 'sat', keys: { '1': 'pubkey' } as any },
      } as any),
    );

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify selectProofsToSend was called with correct amount (before fees)
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, exactAmount, {
      unit: 'sat',
    });

    // Verify getFeesForProofs was called to calculate input fees
    expect(getFeesForProofsSpy).toHaveBeenCalledWith(selectedProofs);

    // Verify setProofState was called twice (inflight, then spent)
    expect(setProofStateSpy).toHaveBeenCalledTimes(2);
    expect(setProofStateSpy).toHaveBeenNthCalledWith(1, mintUrl, ['secret-1'], 'inflight');
    expect(setProofStateSpy).toHaveBeenNthCalledWith(2, mintUrl, ['secret-1'], 'spent');

    // Verify meltProofsBolt11 was called with selected proofs (not swapped proofs)
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(quote, selectedProofs);

    // Verify createOutputsAndIncrementCounters was NOT called (no swap needed)
    expect(mockProofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();

    // Verify saveProofs WAS called to save the change from meltProofsBolt11
    expect(mockProofService.saveProofs).toHaveBeenCalled();

    // Verify events were emitted
    expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
    const paidEvent = emittedEvents.find((e) => e.event === 'melt-quote:paid');
    expect(paidEvent).toBeDefined();
    expect(paidEvent?.payload.mintUrl).toBe(mintUrl);
    expect(paidEvent?.payload.quoteId).toBe(quoteId);
  });

  it('should perform send/swap when selected proofs sum to more than required amount', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const amountWithFee = quote.amount.add(quote.fee_reserve); // 110
    const selectedProofs = [makeProof(150, 'secret-1')]; // More than needed
    const swappedProofs = [makeProof(110, 'secret-2')];
    const keepProofs = [makeProof(40, 'secret-3')];

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));
    const setProofStateSpy = mock(() => Promise.resolve());
    mockProofService.setProofState = setProofStateSpy;
    const createOutputsSpy = mock(() =>
      Promise.resolve({
        keep: [],
        send: [],
        sendAmount: Amount.from(112), // This includes receiver fees (110 + 2)
        keepAmount: Amount.from(38), // This is after fee adjustment (40 - 2)
      }),
    );
    mockProofService.createOutputsAndIncrementCounters = createOutputsSpy;
    const createBlanksSpy = mock(() => Promise.resolve([]));
    mockProofService.createBlankOutputs = createBlanksSpy;

    const saveProofsSpy = mock(() => Promise.resolve());
    mockProofService.saveProofs = saveProofsSpy;
    const meltProofsBolt11Spy = mock(() =>
      Promise.resolve({ change: [makeProof(10, 'secret-4')] }),
    );
    const sendSpy = mock(() => Promise.resolve({ send: swappedProofs, keep: keepProofs }));

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      send: sendSpy,
      getFeesForProofs: mock(() => Amount.zero()), // Mock swap fees as 0
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() =>
      Promise.resolve({
        wallet,
        keysetId: 'keyset-1',
        keyset: { id: 'keyset-1', unit: 'sat', active: true },
        keys: { id: 'keyset-1', unit: 'sat', keys: { '1': 'pubkey' } as any },
      } as any),
    );

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify selectProofsToSend was called
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, amountWithFee, {
      unit: 'sat',
    });

    // Verify createBlankOutputs was called with the correct amount
    // sendAmount ( quote.amount = 100 + quote.fee_reserve = 10) - quote.amount = 100
    expect(createBlanksSpy).toHaveBeenCalledWith(
      Amount.from(10), // 100 + 10 - 100
      mintUrl,
      { unit: 'sat' },
    );
    // Verify createOutputsAndIncrementCounters was called with includeFees option
    // selectedAmount = 150, quote.amount = 100, quote.fee_reserve = 10, swapFees = 0
    // keep = 150 - 100 - 10 - 0 = 40
    // send = 100 + 10 = 110
    expect(createOutputsSpy).toHaveBeenCalledWith(
      mintUrl,
      {
        keep: Amount.from(40), // selectedAmount - quote.amount - quote.fee_reserve - swapFees
        send: Amount.from(110), // quote.amount + quote.fee_reserve
      },
      { includeFees: true, unit: 'sat' },
    );

    // Verify wallet.send was called with sendAmount from outputData (includes receiver fees)
    const expectedOutputConfig = {
      send: { type: 'custom', data: [] },
      keep: { type: 'custom', data: [] },
    };
    expect(sendSpy).toHaveBeenCalledWith(
      Amount.from(112),
      selectedProofs,
      undefined,
      expectedOutputConfig,
    );

    // Verify saveProofs was called with swapped proofs
    expect(saveProofsSpy).toHaveBeenCalled();

    // Verify setProofState was called correctly
    // First: mark selected proofs as spent
    // Second: mark swapped send proofs as inflight
    // Third: mark swapped send proofs as spent after melting
    expect(setProofStateSpy).toHaveBeenCalledTimes(3);
    expect(setProofStateSpy).toHaveBeenNthCalledWith(1, mintUrl, ['secret-1'], 'spent');
    expect(setProofStateSpy).toHaveBeenNthCalledWith(2, mintUrl, ['secret-2'], 'inflight');
    expect(setProofStateSpy).toHaveBeenNthCalledWith(3, mintUrl, ['secret-2'], 'spent');

    const expectedBlankOutputType = { type: 'custom', data: [] };

    // Verify meltProofsBolt11 was called with swapped proofs (not original selected proofs)
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(
      quote,
      swappedProofs,
      undefined,
      expectedBlankOutputType,
    );

    // Verify events were emitted
    expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
    const paidEvent = emittedEvents.find((e) => e.event === 'melt-quote:paid');
    expect(paidEvent).toBeDefined();
  });

  it('should throw error when quote not found', async () => {
    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(null));

    expect(service.payMeltQuote(mintUrl, quoteId)).rejects.toThrow('Quote not found');
  });

  it('should throw error when insufficient proofs', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const amountWithFee = quote.amount.add(quote.fee_reserve); // 110
    const selectedProofs = [makeProof(50, 'secret-1')]; // Less than needed

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));

    expect(service.payMeltQuote(mintUrl, quoteId)).rejects.toThrow(
      'Insufficient proofs to pay melt quote',
    );
  });

  it('should handle multiple proofs summing to exact amount', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const exactAmount = quote.amount.add(quote.fee_reserve); // 110
    const selectedProofs = [
      makeProof(50, 'secret-1'),
      makeProof(30, 'secret-2'),
      makeProof(30, 'secret-3'),
    ]; // Sums to 110

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));
    const setProofStateSpy = mock(() => Promise.resolve());
    mockProofService.setProofState = setProofStateSpy;
    const meltProofsBolt11Spy = mock(() => Promise.resolve({ change: [], quote: quote }));

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      getFeesForProofs: mock(() => Amount.zero()),
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() =>
      Promise.resolve({
        wallet,
        keysetId: 'keyset-1',
        keyset: { id: 'keyset-1', unit: 'sat', active: true },
        keys: { id: 'keyset-1', unit: 'sat', keys: { '1': 'pubkey' } as any },
      } as any),
    );

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify setProofState was called with all proof secrets
    expect(setProofStateSpy).toHaveBeenNthCalledWith(
      1,
      mintUrl,
      ['secret-1', 'secret-2', 'secret-3'],
      'inflight',
    );
    expect(setProofStateSpy).toHaveBeenNthCalledWith(
      2,
      mintUrl,
      ['secret-1', 'secret-2', 'secret-3'],
      'spent',
    );

    // Verify meltProofsBolt11 was called with all selected proofs
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(quote, selectedProofs);

    // Verify no swap was performed
    expect(mockProofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
  });

  it('pays custom-unit melt quotes without falling back to sat', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(10),
      request: 'lnbc110...',
      unit: 'USD',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };
    const exactAmount = quote.amount.add(quote.fee_reserve);
    const selectedProofs = [makeProof(110, 'secret-usd')];

    mockMeltQuoteRepo.getMeltQuote = mock(async () => quote);
    mockProofService.selectProofsToSend = mock(async () => selectedProofs);
    const setProofStateSpy = mock(async () => {});
    mockProofService.setProofState = setProofStateSpy;
    const saveProofsSpy = mock(async () => {});
    mockProofService.saveProofs = saveProofsSpy;
    const meltProofsBolt11Spy = mock(async () => ({ change: [makeProof(1, 'change-usd')] }));
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      getFeesForProofs: mock(() => Amount.zero()),
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(async () => ({
      wallet,
      keysetId: 'keyset-1',
      keyset: { id: 'keyset-1', unit: 'usd', active: true },
      keys: { id: 'keyset-1', unit: 'usd', keys: { '1': 'pubkey' } as any },
    })) as any;

    await service.payMeltQuote(mintUrl, quoteId, { unit: 'usd' });

    expect(mockMintService.assertMintMethodUnitSupported).toHaveBeenCalledWith(
      mintUrl,
      5,
      'bolt11',
      'usd',
    );
    expect(mockWalletService.getWalletWithActiveKeysetId).toHaveBeenCalledWith(mintUrl, 'usd');
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, exactAmount, {
      unit: 'usd',
    });
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(
      expect.objectContaining({ unit: 'usd' }),
      selectedProofs,
    );
    expect(saveProofsSpy).toHaveBeenCalledWith(
      mintUrl,
      expect.arrayContaining([expect.objectContaining({ unit: 'usd', secret: 'change-usd' })]),
    );
    expect(setProofStateSpy).toHaveBeenNthCalledWith(1, mintUrl, ['secret-usd'], 'inflight');
    expect(setProofStateSpy).toHaveBeenNthCalledWith(2, mintUrl, ['secret-usd'], 'spent');
  });
});
