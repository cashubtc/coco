import { Amount, type Proof, type Wallet } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';
import type { MintAdapter } from '../../infra';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler.ts';
import { MeltBolt12Handler } from '../../infra/handlers/melt/MeltBolt12Handler.ts';
import { MeltOnchainHandler } from '../../infra/handlers/melt/MeltOnchainHandler.ts';
import type { ExecutingMeltOperation } from '../../operations/melt/MeltOperation.ts';

const mintUrl = 'https://mint.test';
const quoteId = 'quote-1';
const proof: Proof = { amount: Amount.from(12), C: 'C', id: 'ks', secret: 'input' };

function executing(method: 'bolt11' | 'bolt12' | 'onchain'): ExecutingMeltOperation {
  return {
    id: `op-${method}`,
    state: 'executing',
    mintUrl,
    method,
    methodData:
      method === 'bolt11'
        ? { invoice: 'invoice' }
        : method === 'bolt12'
          ? { offer: 'offer' }
          : { address: 'bc1qtest', amountSats: Amount.from(10), feeIndex: 7 },
    quoteId,
    unit: 'sat',
    amount: Amount.from(10),
    fee_reserve: Amount.from(2),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(12),
    inputProofSecrets: [proof.secret],
    changeOutputData: { keep: [], send: [] },
    createdAt: 1,
    updatedAt: 2,
  } as ExecutingMeltOperation;
}

describe('remote-only Melt handlers', () => {
  it('creates and fetches canonical BOLT11 quotes without persistence dependencies', async () => {
    const wallet = {
      createMeltQuoteBolt11: mock(async () => ({
        quote: quoteId,
        request: 'invoice',
        amount: Amount.from(10),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9999999999,
        state: 'UNPAID' as const,
        payment_preimage: null,
      })),
    } as unknown as Wallet;
    const mintAdapter = {
      checkMeltQuote: mock(async () => ({
        quote: quoteId,
        request: 'invoice',
        amount: Amount.from(10),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9999999999,
        state: 'PENDING' as const,
        payment_preimage: null,
      })),
    } as unknown as MintAdapter;
    const handler = new MeltBolt11Handler();
    const created = await handler.createQuote({
      mintUrl,
      methodData: { invoice: 'invoice', amountSats: Amount.from(10) },
      unit: 'sat',
      wallet,
      mintAdapter,
    });
    const fetched = await handler.fetchRemoteQuote({ quote: created, mintAdapter });
    expect(wallet.createMeltQuoteBolt11).toHaveBeenCalledWith('invoice', Amount.from(10000));
    expect(fetched.state).toBe('PENDING');
  });

  it('creates amountless BOLT11 quotes without inventing an amount', async () => {
    const wallet = {
      createMeltQuoteBolt11: mock(async () => ({
        quote: quoteId,
        request: 'invoice',
        amount: Amount.from(10),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9999999999,
        state: 'UNPAID' as const,
        payment_preimage: null,
      })),
    } as unknown as Wallet;

    await new MeltBolt11Handler().createQuote({
      mintUrl,
      methodData: { invoice: 'invoice' },
      unit: 'sat',
      wallet,
      mintAdapter: {} as MintAdapter,
    });

    expect(wallet.createMeltQuoteBolt11).toHaveBeenCalledWith('invoice', undefined);
  });

  it('creates and fetches canonical BOLT12 quotes with millisat conversion', async () => {
    const wallet = {
      createMeltQuoteBolt12: mock(async () => ({
        quote: 'quote-bolt12',
        request: 'lno1offer',
        amount: Amount.from(10),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9999999999,
        state: 'UNPAID' as const,
        payment_preimage: null,
      })),
    } as unknown as Wallet;
    const mintAdapter = {
      checkMeltQuoteBolt12: mock(async () => ({
        quote: 'quote-bolt12',
        request: 'lno1offer',
        amount: Amount.from(10),
        fee_reserve: Amount.from(2),
        unit: 'sat',
        expiry: 9999999999,
        state: 'PAID' as const,
        payment_preimage: 'bolt12-preimage',
      })),
    } as unknown as MintAdapter;
    const handler = new MeltBolt12Handler();

    const created = await handler.createQuote({
      mintUrl,
      methodData: { offer: 'lno1offer', amountSats: Amount.from(10) },
      unit: 'sat',
      wallet,
      mintAdapter,
    });
    const fetched = await handler.fetchRemoteQuote({ quote: created, mintAdapter });

    expect(wallet.createMeltQuoteBolt12).toHaveBeenCalledWith('lno1offer', Amount.from(10000));
    expect(mintAdapter.checkMeltQuoteBolt12).toHaveBeenCalledWith(mintUrl, 'quote-bolt12');
    expect(fetched).toMatchObject({
      method: 'bolt12',
      state: 'PAID',
      payment_preimage: 'bolt12-preimage',
      change: [],
    });
  });

  it('creates and fetches canonical on-chain quotes with fee options', async () => {
    const feeOptions = [
      { fee_index: 1, fee_reserve: Amount.from(2), estimated_blocks: 6 },
      { fee_index: 7, fee_reserve: Amount.from(3), estimated_blocks: 2 },
    ];
    const wallet = {
      createMeltQuoteOnchain: mock(async () => ({
        quote: 'quote-onchain',
        request: 'bc1qtest',
        amount: Amount.from(10),
        unit: 'sat',
        fee_options: feeOptions,
        selected_fee_index: null,
        expiry: 9999999999,
        state: 'UNPAID' as const,
        outpoint: null,
      })),
    } as unknown as Wallet;
    const mintAdapter = {
      checkMeltQuoteOnchain: mock(async () => ({
        quote: 'quote-onchain',
        request: 'bc1qtest',
        amount: Amount.from(10),
        unit: 'sat',
        fee_options: feeOptions,
        selected_fee_index: 7,
        expiry: 9999999999,
        state: 'PAID' as const,
        outpoint: 'txid:7',
      })),
    } as unknown as MintAdapter;
    const handler = new MeltOnchainHandler();

    const created = await handler.createQuote({
      mintUrl,
      methodData: { address: 'bc1qtest', amountSats: Amount.from(10) },
      unit: 'sat',
      wallet,
      mintAdapter,
    });
    const fetched = await handler.fetchRemoteQuote({ quote: created, mintAdapter });

    expect(wallet.createMeltQuoteOnchain).toHaveBeenCalledWith('bc1qtest', Amount.from(10));
    expect(mintAdapter.checkMeltQuoteOnchain).toHaveBeenCalledWith(mintUrl, 'quote-onchain');
    expect(fetched).toMatchObject({
      method: 'onchain',
      state: 'PAID',
      outpoint: 'txid:7',
      change: [],
    });
  });

  it('returns BOLT11 candidate settlement facts without mutating local storage', async () => {
    const mintAdapter = {
      customMeltBolt11: mock(async () => ({
        state: 'PAID' as const,
        change: [],
        payment_preimage: 'preimage',
      })),
    } as unknown as MintAdapter;
    const operation = executing('bolt11');
    const result = await new MeltBolt11Handler().melt({
      operation: operation as any,
      inputProofs: [proof],
      mintAdapter,
    });
    expect(mintAdapter.customMeltBolt11).toHaveBeenCalledWith(mintUrl, [proof], [], quoteId);
    expect(result).toEqual({
      status: 'PAID',
      change: [],
      finalizedData: { preimage: 'preimage' },
    });
  });

  it('normalizes an authoritative PAID response without change to an explicit empty settlement', async () => {
    const mintAdapter = {
      customMeltBolt11: mock(async () => ({
        state: 'PAID' as const,
        payment_preimage: 'preimage',
      })),
    } as unknown as MintAdapter;

    const result = await new MeltBolt11Handler().melt({
      operation: executing('bolt11') as any,
      inputProofs: [proof],
      mintAdapter,
    });

    expect(result).toEqual({
      status: 'PAID',
      change: [],
      finalizedData: { preimage: 'preimage' },
    });
  });

  it('routes BOLT12 and on-chain melts with method-specific data', async () => {
    const mintAdapter = {
      customMeltBolt12: mock(async () => ({
        state: 'PAID' as const,
        change: [],
        payment_preimage: 'p12',
      })),
      customMeltOnchain: mock(async () => ({
        state: 'PAID' as const,
        change: [],
        outpoint: 'txid:0',
      })),
    } as unknown as MintAdapter;
    const bolt12 = await new MeltBolt12Handler().melt({
      operation: executing('bolt12') as any,
      inputProofs: [proof],
      mintAdapter,
    });
    const onchain = await new MeltOnchainHandler().melt({
      operation: executing('onchain') as any,
      inputProofs: [proof],
      mintAdapter,
    });
    expect(bolt12.finalizedData).toEqual({ preimage: 'p12' });
    expect(onchain.finalizedData).toEqual({ outpoint: 'txid:0' });
    expect(mintAdapter.customMeltOnchain).toHaveBeenCalledWith(mintUrl, [proof], [], quoteId, 7);
  });

  it('allows an authoritative synchronous on-chain PAID settlement without an outpoint', async () => {
    const mintAdapter = {
      customMeltOnchain: mock(async () => ({
        state: 'PAID' as const,
        change: [],
        outpoint: null,
      })),
    } as unknown as MintAdapter;

    const result = await new MeltOnchainHandler().melt({
      operation: executing('onchain') as any,
      inputProofs: [proof],
      mintAdapter,
    });

    expect(result).toEqual({
      status: 'PAID',
      change: [],
      finalizedData: undefined,
    });
  });
});
