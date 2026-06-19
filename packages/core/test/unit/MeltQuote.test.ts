import { Amount, type MeltQuoteOnchainResponse } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import {
  meltQuoteToMethodSnapshot,
  meltQuoteFromOnchainResponse,
  resolveOnchainMeltFeeOption,
  type GenericMeltQuote,
  type MeltQuote,
} from '../../models/MeltQuote.ts';

const mintUrl = 'https://mint.test';

function makeOnchainResponse(
  overrides: Partial<MeltQuoteOnchainResponse> = {},
): MeltQuoteOnchainResponse {
  return {
    quote: 'onchain-melt-quote',
    request: 'bc1ptest',
    amount: Amount.from(10),
    unit: 'sat',
    fee_options: [{ fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: 6 }],
    selected_fee_index: null,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'UNPAID',
    outpoint: null,
    ...overrides,
  };
}

function makeOnchainQuote(overrides: Partial<MeltQuote<'onchain'>> = {}): MeltQuote<'onchain'> {
  return {
    mintUrl,
    method: 'onchain',
    quoteId: 'onchain-melt-quote',
    quote: 'onchain-melt-quote',
    request: 'bc1ptest',
    amount: Amount.from(10),
    unit: 'sat',
    fee_options: [{ fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: 6 }],
    expiry: Math.floor(Date.now() / 1000) + 3600,
    state: 'UNPAID',
    lastObservedRemoteState: 'UNPAID',
    lastObservedRemoteStateAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('MeltQuote model', () => {
  it('requires an explicit onchain fee index', () => {
    expect(() => resolveOnchainMeltFeeOption(makeOnchainQuote())).toThrow(
      'requires an explicit feeIndex',
    );
  });

  it('resolves an explicit onchain fee index', () => {
    const resolved = resolveOnchainMeltFeeOption(makeOnchainQuote(), 1);

    expect(resolved.feeIndex).toBe(1);
    expect(resolved.feeOption.fee_reserve).toEqual(Amount.from(2));
  });

  it('rejects empty or missing onchain fee options', () => {
    expect(() => resolveOnchainMeltFeeOption(makeOnchainQuote({ fee_options: [] }))).toThrow(
      'has no onchain fee options',
    );
    expect(() =>
      meltQuoteFromOnchainResponse(
        mintUrl,
        makeOnchainResponse({ fee_options: undefined as never }),
      ),
    ).toThrow('did not include fee_options');
  });

  it('rejects unknown onchain fee indexes', () => {
    expect(() => resolveOnchainMeltFeeOption(makeOnchainQuote(), 99)).toThrow(
      'does not include onchain fee option 99',
    );
  });

  it('validates onchain fee option indexes and estimated blocks', () => {
    expect(() =>
      meltQuoteFromOnchainResponse(
        mintUrl,
        makeOnchainResponse({
          fee_options: [{ fee_index: 1.5, fee_reserve: Amount.from(2), estimated_blocks: 6 }],
        }),
      ),
    ).toThrow('invalid fee_index');

    expect(() =>
      meltQuoteFromOnchainResponse(
        mintUrl,
        makeOnchainResponse({
          fee_options: [
            { fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: 6 },
            { fee_index: 1, fee_reserve: Amount.from(3), estimated_blocks: 3 },
          ],
        }),
      ),
    ).toThrow('duplicate fee_index');

    expect(() =>
      meltQuoteFromOnchainResponse(
        mintUrl,
        makeOnchainResponse({
          fee_options: [{ fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: -1 }],
        }),
      ),
    ).toThrow('invalid estimated_blocks');
  });

  it('projects generic melt quotes into generic method snapshots', () => {
    const quote: GenericMeltQuote<'gift-card'> = {
      mintUrl,
      method: 'gift-card',
      quoteId: 'generic-melt-quote',
      quote: 'generic-melt-quote',
      request: 'gift-card-request',
      amount: Amount.from(25),
      unit: 'sat',
      fee_reserve: Amount.from(2),
      expiry: 123,
      state: 'PENDING',
      payment_preimage: null,
      rawQuoteData: {
        provider: 'gift-card-provider',
      },
      createdAt: 0,
      updatedAt: 0,
    };

    const snapshot = meltQuoteToMethodSnapshot(quote);

    expect(snapshot.quote).toBe('generic-melt-quote');
    expect(snapshot.request).toBe('gift-card-request');
    expect(snapshot.amount.equals(Amount.from(25))).toBe(true);
    expect(snapshot.unit).toBe('sat');
    expect(Amount.from(snapshot.fee_reserve ?? 0).equals(Amount.from(2))).toBe(true);
    expect(snapshot.expiry).toBe(123);
    expect(snapshot.state).toBe('PENDING');
    expect(snapshot.payment_preimage).toBeNull();
    expect(snapshot.provider).toBe('gift-card-provider');
  });
});
