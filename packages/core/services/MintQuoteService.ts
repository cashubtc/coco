import type { MintQuoteRepository } from '../repositories';
import type { WalletService } from './WalletService';
import type { ProofService } from './ProofService';
import type { MintQuoteResponse, MintQuoteState } from '@cashu/cashu-ts';
import type { CoreEvents, EventBus } from '@core/events';
import type { Logger } from '../logging/Logger.ts';

export class MintQuoteService {
  private readonly mintQuoteRepo: MintQuoteRepository;
  private readonly walletService: WalletService;
  private readonly proofService: ProofService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintQuoteRepo: MintQuoteRepository,
    walletService: WalletService,
    proofService: ProofService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.mintQuoteRepo = mintQuoteRepo;
    this.walletService = walletService;
    this.proofService = proofService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /**
   * Create a mint quote and return an awaiter that resolves once the quote is paid
   * and proofs are minted, persisted, and counters updated.
   */
  async mintProofs(
    mintUrl: string,
    amount: number,
  ): Promise<{
    quote: MintQuoteResponse;
    handlePayment: () => {
      promise: Promise<MintQuoteResponse>;
      unsubscribe: () => void;
    };
  }> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new Error('mintUrl is required');
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount must be a positive number');
    }

    const { wallet, keysetId } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const quote = await wallet.createMintQuote(amount);

    this.logger?.info('Mint quote created', { mintUrl, amount, quoteId: quote.quote });

    // Persist the newly created quote and emit initial state
    await this.mintQuoteRepo.addMintQuote({ ...quote, mintUrl });
    await this.setMintQuoteState(mintUrl, quote.quote, quote.state as MintQuoteState);

    const handlePayment = () => {
      let unsubscribeHandle: (() => void) | undefined;
      let settled = false;
      let pendingUnsubscribe = false;

      const safeCleanup = () => {
        if (settled) return;
        settled = true;
        try {
          unsubscribeHandle?.();
        } catch {}
      };

      const unsubscribe = () => {
        if (settled) return;
        if (unsubscribeHandle) {
          try {
            unsubscribeHandle();
            unsubscribeHandle = undefined;
          } catch {}
        } else {
          pendingUnsubscribe = true;
        }
      };

      const promise = new Promise<MintQuoteResponse>(async (resolve, reject) => {
        try {
          unsubscribeHandle = await wallet.onMintQuotePaid(
            quote.quote,
            async () => {
              if (settled) return;
              try {
                await this.setMintQuoteState(mintUrl, quote.quote, 'PAID');
                const proofs = await wallet.mintProofs(amount, quote.quote, { keysetId });
                await this.proofService.saveProofsAndIncrementCounters(mintUrl, proofs);
                await this.setMintQuoteState(mintUrl, quote.quote, 'ISSUED');
                this.logger?.info('Mint quote issued', { mintUrl, quoteId: quote.quote });
                resolve(quote);
              } catch (err) {
                this.logger?.error('Error minting proofs after payment', {
                  mintUrl,
                  quoteId: quote.quote,
                  err,
                });
                reject(err as Error);
              } finally {
                safeCleanup();
              }
            },
            (err: unknown) => {
              if (settled) return;
              try {
                this.logger?.error('Mint quote payment error', {
                  mintUrl,
                  quoteId: quote.quote,
                  err,
                });
                reject(err as Error);
              } finally {
                safeCleanup();
              }
            },
          );

          if (pendingUnsubscribe) {
            try {
              unsubscribeHandle?.();
              unsubscribeHandle = undefined;
            } catch {}
          }
        } catch (err) {
          reject(err as Error);
        }
      });

      return { promise, unsubscribe };
    };

    return { quote, handlePayment };
  }

  async createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse> {
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const quote = await wallet.createMintQuote(amount);
    await this.mintQuoteRepo.addMintQuote({ ...quote, mintUrl });
    try {
      await this.eventBus.emit('mint-quote:created', { mintUrl, quoteId: quote.quote, quote });
    } catch {
      // ignore event handler errors
    }

    return quote;
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    const quote = await this.mintQuoteRepo.getMintQuote(mintUrl, quoteId);
    if (!quote) {
      throw new Error('Quote not found');
    }
    const { wallet, keysetId } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const proofs = await wallet.mintProofs(quote.amount, quote.quote, { keysetId });
    await this.setMintQuoteState(mintUrl, quoteId, 'ISSUED');
    await this.proofService.saveProofsAndIncrementCounters(mintUrl, proofs);
  }

  private async setMintQuoteState(
    mintUrl: string,
    quoteId: string,
    state: MintQuoteState,
  ): Promise<void> {
    await this.mintQuoteRepo.setMintQuoteState(mintUrl, quoteId, state);
    try {
      await this.eventBus.emit('mint-quote:state-changed', { mintUrl, quoteId, state });
    } catch {
      // ignore event handler errors
    }
  }
}
