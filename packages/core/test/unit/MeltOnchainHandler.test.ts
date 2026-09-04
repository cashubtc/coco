import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MeltOnchainHandler } from '../../infra/handlers/melt/MeltOnchainHandler';
import type { MeltMethodMeta } from '../../operations/melt/MeltMethodHandler';
import type {
  ExecutingMeltOperation,
  InitMeltOperation,
  PendingMeltOperation,
} from '../../operations/melt/MeltOperation';
import {
  createQuoteMeltTestDeps,
  makeQuoteMeltCoreProof,
  QUOTE_MELT_FIXTURE as f,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('MeltOnchainHandler adapter contract', () => {
  let handler: MeltOnchainHandler;
  let fixture: ReturnType<typeof createQuoteMeltTestDeps>;
  const input = makeQuoteMeltCoreProof('input-1', 23);
  const initOperation = (): InitMeltOperation & MeltMethodMeta<'onchain'> => ({
    id: 'operation-onchain',
    state: 'init',
    mintUrl: f.mintUrl,
    unit: 'sat',
    method: 'onchain',
    methodData: { address: f.address, amountSats: Amount.from(21), feeIndex: 7 },
    quoteId: f.quoteId,
    createdAt: 0,
    updatedAt: 0,
  });
  const executingOperation = (): ExecutingMeltOperation & MeltMethodMeta<'onchain'> => ({
    ...initOperation(),
    state: 'executing',
    quoteId: f.quoteId,
    amount: Amount.from(21),
    fee_reserve: Amount.from(2),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(23),
    inputProofSecrets: ['input-1'],
    changeOutputData: { keep: [], send: [] },
  });
  const pendingOperation = (): PendingMeltOperation & MeltMethodMeta<'onchain'> => ({
    ...executingOperation(),
    state: 'pending',
  });

  beforeEach(() => {
    handler = new MeltOnchainHandler();
    fixture = createQuoteMeltTestDeps();
    fixture.mocks.getProofsByOperationId.mockResolvedValue([input]);
    fixture.mocks.selectProofsToSend.mockResolvedValue([input]);
  });

  it('creates canonical quotes with fee options', async () => {
    const quote = await handler.createQuote({
      ...fixture.deps,
      mintUrl: f.mintUrl,
      methodData: { address: f.address, amountSats: Amount.from(21) },
      unit: 'sat',
      wallet: fixture.wallet,
    });

    expect(fixture.mocks.createMeltQuoteOnchain).toHaveBeenCalledWith(f.address, Amount.from(21));
    expect(quote).toMatchObject({ method: 'onchain', quoteId: f.quoteId });
    expect(quote.fee_options[1]?.fee_index).toBe(7);
  });

  it('prepares with the selected fee option', async () => {
    const prepared = await handler.prepare({
      ...fixture.deps,
      operation: initOperation(),
      quote: fixture.onchainQuote(),
      wallet: fixture.wallet,
    });

    expect(prepared.fee_reserve).toEqual(Amount.from(2));
    expect(fixture.mocks.selectProofsToSend).toHaveBeenCalledWith(
      f.mintUrl,
      { amount: Amount.from(23), unit: 'sat' },
      true,
    );
  });

  it('executes with the fee index and maps a returned outpoint', async () => {
    fixture.mocks.customMeltOnchain.mockResolvedValueOnce({
      ...fixture.onchainQuote(),
      state: 'PAID',
      outpoint: 'txid:0',
    });

    const result = await handler.execute({
      ...fixture.deps,
      operation: executingOperation(),
      wallet: fixture.wallet,
      reservedProofs: [input],
    });

    expect(fixture.mocks.customMeltOnchain).toHaveBeenCalledWith(
      f.mintUrl,
      [input],
      [],
      f.quoteId,
      7,
    );
    if (result.status !== 'PAID') throw new Error('Expected paid result');
    expect(result.finalized.finalizedData).toEqual({ outpoint: 'txid:0' });
  });

  it('allows synchronous settlement without an outpoint', async () => {
    const result = await handler.execute({
      ...fixture.deps,
      operation: executingOperation(),
      wallet: fixture.wallet,
      reservedProofs: [input],
    });

    if (result.status !== 'PAID') throw new Error('Expected paid result');
    expect(result.finalized.finalizedData).toBeUndefined();
  });

  it('fetches through the onchain full-quote endpoint', async () => {
    const quote = await handler.fetchRemoteQuote({
      ...fixture.deps,
      quote: { mintUrl: f.mintUrl, quoteId: f.quoteId },
    } as never);

    expect(fixture.mocks.checkMeltQuoteOnchain).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
    expect(quote.method).toBe('onchain');
  });

  it('uses the state-only endpoint for pending checks', async () => {
    await expect(
      handler.checkPending({
        ...fixture.deps,
        operation: pendingOperation(),
        wallet: fixture.wallet,
      }),
    ).resolves.toBe('finalize');
    expect(fixture.mocks.checkMeltQuoteOnchainState).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
  });

  it('uses the full-quote endpoint when finalizing', async () => {
    const result = await handler.finalize({
      ...fixture.deps,
      operation: pendingOperation(),
    });

    expect(fixture.mocks.checkMeltQuoteOnchain).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
    expect(result.finalizedData).toBeUndefined();
  });
});
