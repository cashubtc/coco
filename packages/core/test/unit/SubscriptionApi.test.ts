import { describe, expect, it, mock } from 'bun:test';
import { SubscriptionApi } from '../../api/SubscriptionApi.ts';
import type { SubscriptionCallback, SubscriptionManager } from '../../infra/SubscriptionManager.ts';
import type { SubscriptionKind, UnsubscribeHandler } from '../../infra/SubscriptionProtocol.ts';

const mintUrl = 'https://mint.test';

function createSubscriptionApiHarness() {
  let callback: SubscriptionCallback | undefined;
  const unsubscribe = mock(async () => {});
  const subscribe = mock(
    async (
      _mintUrl: string,
      _kind: SubscriptionKind,
      _filters: string[],
      onNotification?: SubscriptionCallback,
    ): Promise<{ subId: string; unsubscribe: UnsubscribeHandler }> => {
      callback = onNotification;
      return { subId: 'sub-1', unsubscribe };
    },
  );

  const subscriptions = { subscribe } as unknown as SubscriptionManager;
  const api = new SubscriptionApi(subscriptions);

  return {
    api,
    subscribe,
    unsubscribe,
    emit: async (payload: unknown) => {
      await callback?.(payload);
    },
  };
}

describe('SubscriptionApi', () => {
  it('awaitMintQuotePaid ignores initial UNPAID notifications', async () => {
    const harness = createSubscriptionApiHarness();
    let resolved: unknown;

    const wait = harness.api.awaitMintQuotePaid(mintUrl, 'quote-1').then((payload) => {
      resolved = payload;
      return payload;
    });

    await harness.emit({ quote: 'quote-1', state: 'UNPAID' });
    await Promise.resolve();

    expect(resolved).toBeUndefined();
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    const paidPayload = { quote: 'quote-1', state: 'PAID' };
    await harness.emit(paidPayload);

    await expect(wait).resolves.toBe(paidPayload);
    expect(harness.subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_mint_quote',
      ['quote-1'],
      expect.any(Function),
    );
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('awaitMintQuotePaid also resolves when the quote is already ISSUED', async () => {
    const harness = createSubscriptionApiHarness();
    const wait = harness.api.awaitMintQuotePaid(mintUrl, 'quote-issued');

    const issuedPayload = { quote: 'quote-issued', state: 'ISSUED' };
    await harness.emit(issuedPayload);

    await expect(wait).resolves.toBe(issuedPayload);
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('awaitMeltQuotePaid waits for PAID instead of the first notification', async () => {
    const harness = createSubscriptionApiHarness();
    let resolved: unknown;

    const wait = harness.api.awaitMeltQuotePaid(mintUrl, 'melt-quote-1').then((payload) => {
      resolved = payload;
      return payload;
    });

    await harness.emit({ quote: 'melt-quote-1', state: 'PENDING' });
    await Promise.resolve();

    expect(resolved).toBeUndefined();
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    const paidPayload = { quote: 'melt-quote-1', state: 'PAID' };
    await harness.emit(paidPayload);

    await expect(wait).resolves.toBe(paidPayload);
    expect(harness.subscribe).toHaveBeenCalledWith(
      mintUrl,
      'bolt11_melt_quote',
      ['melt-quote-1'],
      expect.any(Function),
    );
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
