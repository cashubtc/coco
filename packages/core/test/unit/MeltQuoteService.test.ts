import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { MeltQuoteService } from '../../services/MeltQuoteService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MeltQuoteRepository } from '../../repositories';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { Proof } from '@cashu/cashu-ts';
import type { MeltQuote } from '../../models/MeltQuote';

describe('MeltQuoteService.payMeltQuote', () => {
  const mintUrl = 'https://mint.test';
  const quoteId = 'quote-123';

  let service: MeltQuoteService;
  let mockProofService: ProofService;
  let mockWalletService: WalletService;
  let mockMeltQuoteRepo: MeltQuoteRepository;
  let eventBus: EventBus<CoreEvents>;
  let emittedEvents: Array<{ event: string; payload: any }>;

  const makeProof = (amount: number, secret: string): Proof =>
    ({
      amount,
      secret,
      C: 'C_' as any,
      id: 'keyset-1',
    } as Proof);

  beforeEach(() => {
    emittedEvents = [];
    eventBus = new EventBus<CoreEvents>();
    eventBus.on('melt-quote:paid', (payload) => {
      emittedEvents.push({ event: 'melt-quote:paid', payload });
    });
    eventBus.on('melt-quote:state-changed', (payload) => {
      emittedEvents.push({ event: 'melt-quote:state-changed', payload });
    });

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
        Promise.resolve({ keep: [], send: [], sendAmount: 0, keepAmount: 0 }),
      ),
      saveProofs: mock(() => Promise.resolve()),
    } as any;

    mockWalletService = {
      async getWalletWithActiveKeysetId() {
        return {
          wallet: {
            meltProofs: mock(() => Promise.resolve({ change: [], quote: {} as any })),
            send: mock(() => Promise.resolve({ send: [], keep: [] })),
            getFeesForProofs: mock(() => 0), // Default mock for getFeesForProofs
          },
        };
      },
    } as any;

    service = new MeltQuoteService(
      mockProofService,
      mockWalletService,
      mockMeltQuoteRepo,
      eventBus,
      undefined,
    );
  });

  it('should skip send/swap when selected proofs sum to exact amount', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: 100,
      fee_reserve: 10,
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const exactAmount = quote.amount + quote.fee_reserve; // 110
    const selectedProofs = [makeProof(110, 'secret-1')];

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));
    const setProofStateSpy = mock(() => Promise.resolve());
    mockProofService.setProofState = setProofStateSpy;
    const meltProofsSpy = mock(() => Promise.resolve({ change: [], quote: quote }));
    const getFeesForProofsSpy = mock(() => 0);

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofs: meltProofsSpy,
      getFeesForProofs: getFeesForProofsSpy,
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() => Promise.resolve({ wallet }));

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify selectProofsToSend was called with correct amount (before fees)
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, exactAmount);

    // Verify getFeesForProofs was called to calculate input fees
    expect(getFeesForProofsSpy).toHaveBeenCalledWith(selectedProofs);

    // Verify setProofState was called twice (inflight, then spent)
    expect(setProofStateSpy).toHaveBeenCalledTimes(2);
    expect(setProofStateSpy).toHaveBeenNthCalledWith(1, mintUrl, ['secret-1'], 'inflight');
    expect(setProofStateSpy).toHaveBeenNthCalledWith(2, mintUrl, ['secret-1'], 'spent');

    // Verify meltProofs was called with selected proofs (not swapped proofs)
    expect(meltProofsSpy).toHaveBeenCalledWith(quote, selectedProofs);

    // Verify createOutputsAndIncrementCounters was NOT called (no swap needed)
    expect(mockProofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();

    // Verify saveProofs WAS called to save the change from meltProofs
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
      amount: 100,
      fee_reserve: 10,
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const amountWithFee = quote.amount + quote.fee_reserve; // 110
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
        sendAmount: 112, // This includes receiver fees (110 + 2)
        keepAmount: 38, // This is after fee adjustment (40 - 2)
      }),
    );
    mockProofService.createOutputsAndIncrementCounters = createOutputsSpy;
    const saveProofsSpy = mock(() => Promise.resolve());
    mockProofService.saveProofs = saveProofsSpy;
    const meltProofsSpy = mock(() => Promise.resolve({ change: [], quote: quote }));
    const sendSpy = mock(() => Promise.resolve({ send: swappedProofs, keep: keepProofs }));

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofs: meltProofsSpy,
      send: sendSpy,
      getFeesForProofs: mock(() => 0), // Mock swap fees as 0
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() => Promise.resolve({ wallet }));

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify selectProofsToSend was called
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, amountWithFee);

    // Verify createOutputsAndIncrementCounters was called with includeFees option
    // selectedAmount = 150, quote.amount = 100, quote.fee_reserve = 10, swapFees = 0
    // keep = 150 - 100 - 10 - 0 = 40
    // send = 100 + 10 = 110
    expect(createOutputsSpy).toHaveBeenCalledWith(
      mintUrl,
      {
        keep: 40, // selectedAmount - quote.amount - quote.fee_reserve - swapFees
        send: 110, // quote.amount + quote.fee_reserve
      },
      { includeFees: true },
    );

    // Verify wallet.send was called with sendAmount from outputData (includes receiver fees)
    expect(sendSpy).toHaveBeenCalledWith(112, selectedProofs, expect.any(Object));

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

    // Verify meltProofs was called with swapped proofs (not original selected proofs)
    expect(meltProofsSpy).toHaveBeenCalledWith(quote, swappedProofs);

    // Verify events were emitted
    expect(emittedEvents.length).toBeGreaterThanOrEqual(2);
    const paidEvent = emittedEvents.find((e) => e.event === 'melt-quote:paid');
    expect(paidEvent).toBeDefined();
  });

  it('should throw error when quote not found', async () => {
    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(null));

    await expect(service.payMeltQuote(mintUrl, quoteId)).rejects.toThrow('Quote not found');
  });

  it('should throw error when insufficient proofs', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: 100,
      fee_reserve: 10,
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const amountWithFee = quote.amount + quote.fee_reserve; // 110
    const selectedProofs = [makeProof(50, 'secret-1')]; // Less than needed

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));

    await expect(service.payMeltQuote(mintUrl, quoteId)).rejects.toThrow(
      'Insufficient proofs to pay melt quote',
    );
  });

  it('should handle multiple proofs summing to exact amount', async () => {
    const quote: MeltQuote = {
      quote: quoteId,
      amount: 100,
      fee_reserve: 10,
      request: 'lnbc110...',
      unit: 'sat',
      mintUrl,
      state: 'PENDING',
      expiry: new Date(Date.now() + 1000 * 60 * 60 * 24).getTime(),
      payment_preimage: 'payment_preimage',
    };

    const exactAmount = quote.amount + quote.fee_reserve; // 110
    const selectedProofs = [
      makeProof(50, 'secret-1'),
      makeProof(30, 'secret-2'),
      makeProof(30, 'secret-3'),
    ]; // Sums to 110

    mockMeltQuoteRepo.getMeltQuote = mock(() => Promise.resolve(quote));
    mockProofService.selectProofsToSend = mock(() => Promise.resolve(selectedProofs));
    const setProofStateSpy = mock(() => Promise.resolve());
    mockProofService.setProofState = setProofStateSpy;
    const meltProofsSpy = mock(() => Promise.resolve({ change: [], quote: quote }));

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofs: meltProofsSpy,
      getFeesForProofs: mock(() => 0),
    };
    mockWalletService.getWalletWithActiveKeysetId = mock(() => Promise.resolve({ wallet }));

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

    // Verify meltProofs was called with all selected proofs
    expect(meltProofsSpy).toHaveBeenCalledWith(quote, selectedProofs);

    // Verify no swap was performed
    expect(mockProofService.createOutputsAndIncrementCounters).not.toHaveBeenCalled();
  });
});
