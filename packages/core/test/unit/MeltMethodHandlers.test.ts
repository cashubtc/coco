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

  it('performs only the remote pre-swap and returns candidate proofs', async () => {
    const input = { ...executing('bolt11'), needsSwap: true } as ExecutingMeltOperation;
    input.swapOutputData = {
      keep: [
        {
          blindedMessage: { amount: 1, id: 'ks', B_: 'keep-B' },
          blindingFactor: '01',
          secret: Buffer.from('keep').toString('hex'),
        },
      ],
      send: [
        {
          blindedMessage: { amount: 11, id: 'ks', B_: 'send-B' },
          blindingFactor: '02',
          secret: Buffer.from('send').toString('hex'),
        },
      ],
    } as any;
    const candidates = {
      keep: [{ ...proof, amount: Amount.from(1), secret: 'keep' }],
      send: [{ ...proof, amount: Amount.from(11), secret: 'send' }],
    };
    const wallet = { send: mock(async () => candidates) } as unknown as Wallet;
    const result = await new MeltBolt11Handler().swap({
      operation: input as any,
      wallet,
      inputProofs: [proof],
    });
    expect(result).toEqual(candidates);
    expect(wallet.send).toHaveBeenCalledTimes(1);
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
});
