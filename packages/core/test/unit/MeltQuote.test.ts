import { Amount, type MeltQuoteOnchainResponse } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import {
  meltQuoteFromOnchainResponse,
  resolveOnchainMeltFeeOption,
  type MeltQuote,
} from '../../models/MeltQuote.ts';

const mintUrl = 'https://mint.test';

function makeOnchainResponse(
  overrides: Partial<MeltQuoteOnchainResponse> = {},
): MeltQuoteOnchainResponse {
  return {
    quote: 'onchain-melt-quote',
    request: 'bc1ptest',
    method: 'onchain',
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
});
