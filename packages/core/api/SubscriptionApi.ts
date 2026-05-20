import type { Logger } from '../logging/Logger.ts';
import { SubscriptionManager } from '../infra/SubscriptionManager.ts';
import type { SubscriptionKind, UnsubscribeHandler } from '../infra/SubscriptionProtocol.ts';

type QuoteStatePayload = {
  state?: unknown;
};

function getQuoteState(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const state = (payload as QuoteStatePayload).state;
  return typeof state === 'string' ? state : undefined;
}

export class SubscriptionApi {
  private readonly subs: SubscriptionManager;
  private readonly logger?: Logger;

  constructor(subs: SubscriptionManager, logger?: Logger) {
    this.subs = subs;
    this.logger = logger;
  }

  async awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitMatchingNotification(
      mintUrl,
      'bolt11_mint_quote',
      [quoteId],
      (payload) => {
        const state = getQuoteState(payload);
        return state === 'PAID' || state === 'ISSUED';
      },
    );
  }

  async awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitMatchingNotification(
      mintUrl,
      'bolt11_melt_quote',
      [quoteId],
      (payload) => getQuoteState(payload) === 'PAID',
    );
  }

  private async awaitMatchingNotification(
    mintUrl: string,
    kind: SubscriptionKind,
    filters: string[],
    matches: (payload: unknown) => boolean,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let unsubscribe: UnsubscribeHandler | undefined;

      const complete = (payload: unknown) => {
        if (settled || !matches(payload)) {
          return;
        }

        settled = true;
        resolve(payload);
        void unsubscribe?.().catch(() => undefined);
      };

      this.subs
        .subscribe(mintUrl, kind, filters, complete)
        .then((subscription) => {
          unsubscribe = subscription.unsubscribe;
          if (settled) {
            void unsubscribe().catch(() => undefined);
          }
        })
        .catch((err) => {
          this.logger?.error('Failed to await subscription notification', { mintUrl, kind, err });
          reject(err);
        });
    });
  }
}
