import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { MeltQuoteService } from '../../services/MeltQuoteService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { MeltQuoteRepository } from '../../repositories';
import type { MintService } from '../../services/MintService';
import type { ProofService } from '../../services/ProofService';
import type { WalletService } from '../../services/WalletService';
import type { Proof } from '@cashu/cashu-ts';
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

    mockMintService = {
      isTrustedMint: mock(() => Promise.resolve(true)),
    } as any;

    mockMeltQuoteRepo = {
      async getMeltQuote() {
        return null;
      },
      async addMeltQuote() { },
      async setMeltQuoteState() { },
      async getPendingMeltQuotes() {
        return [];
      },
    } as MeltQuoteRepository;

    mockProofService = {
      async selectProofsToSend() {
        return [];
      },
      async setProofState() { },
      saveProofs: mock(() => Promise.resolve()),
    } as any;

    mockWalletService = {
      async getWalletWithActiveKeysetId() {
        return {
          wallet: {
            meltProofsBolt11: mock(() => Promise.resolve({ change: [], quote: {} as any })),
            send: mock(() => Promise.resolve({ send: [], keep: [] })),
            getFeesForProofs: mock(() => 0), // Default mock for getFeesForProofs
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
    const meltProofsBolt11Spy = mock(() => Promise.resolve({ change: [], quote: quote }));
    const getFeesForProofsSpy = mock(() => 0);

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      getFeesForProofs: getFeesForProofsSpy,
    };
    // TODO: come back to this. do we really need to add the keysetId, keyset, keys here?
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
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(quote, selectedProofs);

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
    const saveProofsSpy = mock(() => Promise.resolve());
    mockProofService.saveProofs = saveProofsSpy;
    const meltBolt11Run = mock(() => Promise.resolve({ change: [makeProof(10, 'secret-4')] }));
    const sendRun = mock(() => Promise.resolve({ send: swappedProofs, keep: keepProofs }));

    // Create a wallet object that will be returned consistently and that provides
    // the ops.meltBolt11(...).asDeterministic().run() and ops.send(...).asDeterministic().run()
    const wallet = {
      ops: {
        meltBolt11: mock(() => ({ asDeterministic: mock(() => ({ run: meltBolt11Run })) })),
        send: mock(() => ({ asDeterministic: mock(() => ({ run: sendRun })) })),
      },
      getFeesForProofs: mock(() => 0), // Mock swap fees as 0
    };
    // TODO: come back to this. do we really need to add the keysetId, keyset, keys here?
    mockWalletService.getWalletWithActiveKeysetId = mock(() => Promise.resolve({ wallet }));

    await service.payMeltQuote(mintUrl, quoteId);

    // Verify selectProofsToSend was called
    expect(mockProofService.selectProofsToSend).toHaveBeenCalledWith(mintUrl, amountWithFee);

    // Verify wallet.ops.meltBolt11 and wallet.ops.send were called via their asDeterministic.run chains
    expect(wallet.ops.meltBolt11).toHaveBeenCalledWith(quote, selectedProofs);

    // Verify saveProofs was called for the change returned by melt
    expect(saveProofsSpy).toHaveBeenCalledTimes(1);
    const firstSave = (saveProofsSpy as any).mock.calls[0];
    expect(firstSave[0]).toBe(mintUrl);
    expect(Array.isArray(firstSave[1])).toBeTruthy();

    // Verify setProofState was called: first inflight, then spent for selected proofs
    expect(setProofStateSpy).toHaveBeenCalledTimes(2);
    expect(setProofStateSpy).toHaveBeenNthCalledWith(
      1,
      mintUrl,
      selectedProofs.map((p) => p.secret),
      'inflight',
    );
    expect(setProofStateSpy).toHaveBeenNthCalledWith(
      2,
      mintUrl,
      selectedProofs.map((p) => p.secret),
      'spent',
    );

    // Verify meltProofs was called via ops.meltBolt11 and returns change that was saved

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

    expect(service.payMeltQuote(mintUrl, quoteId)).rejects.toThrow(
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
    const meltProofsBolt11Spy = mock(() => Promise.resolve({ change: [], quote: quote }));

    // Create a wallet object that will be returned consistently
    const wallet = {
      meltProofsBolt11: meltProofsBolt11Spy,
      getFeesForProofs: mock(() => 0),
    };
    // TODO: come back to this. do we really need to add the keysetId, keyset, keys here?
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
    expect(meltProofsBolt11Spy).toHaveBeenCalledWith(quote, selectedProofs);

    // TODO: what can we do to verify no swap was performed?
  });
});
