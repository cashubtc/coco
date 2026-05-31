import { describe, expect, it, mock } from 'bun:test';
import { SubscriptionApi } from '../../api/SubscriptionApi.ts';
import type { SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { SubscriptionKind } from '../../infra/SubscriptionProtocol.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';

describe('SubscriptionApi', () => {
  function createApi(payload: unknown) {
    const unsubscribe = mock(async () => undefined);
    const subscribe = mock(
      async (
        _mintUrl: string,
        _kind: SubscriptionKind,
        _filters: string[],
        onNotification?: (payload: unknown) => void,
      ) => {
        setTimeout(() => onNotification?.(payload), 0);
        return { subId: 'sub-1', unsubscribe };
      },
    );
    const api = new SubscriptionApi({ subscribe } as unknown as SubscriptionManager);

    return { api, subscribe, unsubscribe };
  }

  it('awaits onchain mint quote notifications and unsubscribes after the first payload', async () => {
    const payload = { quote: quoteId, amount_paid: 1, amount_issued: 0 };
    const { api, subscribe, unsubscribe } = createApi(payload);

    await expect(api.awaitMintQuotePaid(mintUrl, quoteId, 'onchain')).resolves.toBe(payload);

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_mint_quote',
      [quoteId],
      expect.any(Function),
    );
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('awaits onchain melt quote notifications', async () => {
    const payload = { quote: quoteId, state: 'PAID' };
    const { api, subscribe } = createApi(payload);

    await expect(api.awaitMeltQuotePaid(mintUrl, quoteId, 'onchain')).resolves.toBe(payload);

    expect(subscribe).toHaveBeenCalledWith(
      mintUrl,
      'onchain_melt_quote',
      [quoteId],
      expect.any(Function),
    );
  });
});
