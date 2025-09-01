import type { MintQuoteResponse } from '@cashu/cashu-ts';
import type { Logger } from '../logging/Logger.ts';
import type { SubscriptionManager } from '../infra/SubscriptionManager.ts';

type MintQuotePayload = MintQuoteResponse & { mintUrl?: string };

export class SubscriptionApi {
  private readonly subs: SubscriptionManager;
  private readonly logger?: Logger;

  constructor(subscriptions: SubscriptionManager, logger?: Logger) {
    this.subs = subscriptions;
    this.logger = logger;
  }

  async awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<MintQuoteResponse> {
    return this.awaitQuotePaid(mintUrl, 'bolt11_mint_quote', quoteId);
  }

  async awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<MintQuoteResponse> {
    return this.awaitQuotePaid(mintUrl, 'bolt11_melt_quote', quoteId);
  }

  private async awaitQuotePaid(
    mintUrl: string,
    kind: 'bolt11_mint_quote' | 'bolt11_melt_quote',
    quoteId: string,
  ): Promise<MintQuoteResponse> {
    return new Promise<MintQuoteResponse>(async (resolve, reject) => {
      let resolved = false;
      try {
        const { subId, unsubscribe } = await this.subs.subscribe<MintQuotePayload>(
          mintUrl,
          kind,
          [quoteId],
          (payload) => {
            try {
              // Accept both PAID and ISSUED as terminal states to proceed
              if (payload.state === 'PAID' || payload.state === 'ISSUED') {
                if (!resolved) {
                  resolved = true;
                  unsubscribe()
                    .catch((err) =>
                      this.logger?.warn('Unsubscribe failed', { mintUrl, subId, err }),
                    )
                    .finally(() => resolve(payload));
                }
              }
            } catch (err) {
              if (!resolved) {
                resolved = true;
                unsubscribe()
                  .catch(() => undefined)
                  .finally(() => reject(err));
              }
            }
          },
        );

        this.logger?.debug?.('Awaiting quote via subscription', { mintUrl, kind, subId, quoteId });
      } catch (err) {
        reject(err);
      }
    });
  }
}
