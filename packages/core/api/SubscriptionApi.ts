import type { Logger } from '../logging/Logger.ts';
import { SubscriptionManager } from '../infra/SubscriptionManager.ts';
import type { SubscriptionKind } from '../infra/SubscriptionProtocol.ts';
import type { MeltQuoteState, MintQuoteState } from '@cashu/cashu-ts';

export class SubscriptionApi {
  private readonly subs: SubscriptionManager;
  private readonly logger?: Logger;

  constructor(subs: SubscriptionManager, logger?: Logger) {
    this.subs = subs;
    this.logger = logger;
  }

  async awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitFirstMatchingNotification(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      (payload) => {
        const state = (payload as { state?: MintQuoteState }).state;
        return state === 'PAID' || state === 'ISSUED';
      },
    );
  }

  async awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitFirstMatchingNotification(
      mintUrl,
      'bolt11_melt_quote',
      [quoteId],
      (payload) => {
        const state = (payload as { state?: MeltQuoteState }).state;
        return state === 'PAID';
      },
    );
  }

  private async awaitFirstMatchingNotification(
    mintUrl: string,
    kind: SubscriptionKind,
    filters: string[],
    predicate: (payload: unknown) => boolean,
  ): Promise<unknown> {
    return new Promise<unknown>(async (resolve, reject) => {
      try {
        const { unsubscribe } = await this.subs.subscribe(mintUrl, kind, filters, (payload) => {
          if (!predicate(payload)) {
            return;
          }
          try {
            resolve(payload);
          } finally {
            void unsubscribe().catch(() => undefined);
          }
        });
      } catch (err) {
        this.logger?.error('Failed to await subscription notification', { mintUrl, kind, err });
        reject(err);
      }
    });
  }
}
