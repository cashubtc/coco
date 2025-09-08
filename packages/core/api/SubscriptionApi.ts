import type { Logger } from '../logging/Logger.ts';
import { SubscriptionManager } from '../infra/SubscriptionManager.ts';
import type { SubscriptionKind } from '../infra/SubscriptionProtocol.ts';

export class SubscriptionApi {
  private readonly subs: SubscriptionManager;
  private readonly logger?: Logger;

  constructor(subs: SubscriptionManager, logger?: Logger) {
    this.subs = subs;
    this.logger = logger;
  }

  async awaitMintQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitFirstNotification(mintUrl, 'bolt11_mint_quote', [quoteId]);
  }

  async awaitMeltQuotePaid(mintUrl: string, quoteId: string): Promise<unknown> {
    return this.awaitFirstNotification(mintUrl, 'bolt11_melt_quote', [quoteId]);
  }

  private async awaitFirstNotification(
    mintUrl: string,
    kind: SubscriptionKind,
    filters: string[],
  ): Promise<unknown> {
    return new Promise<unknown>(async (resolve, reject) => {
      try {
        const { unsubscribe } = await this.subs.subscribe(mintUrl, kind, filters, (payload) => {
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
