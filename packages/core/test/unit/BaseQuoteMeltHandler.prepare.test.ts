import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ProofValidationError } from '../../models/Error';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltProof,
  QUOTE_MELT_FIXTURE,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler prepare', () => {
  let harness: QuoteMeltHandlerHarness;

  beforeEach(() => {
    harness = createQuoteMeltHandlerHarness();
  });

  it('prepares a direct melt from the supplied quote', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('input-1', 55),
      makeQuoteMeltProof('input-2', 55),
    ]);

    const result = await harness.handler.prepare(
      harness.buildPrepareContext(harness.makeInitOperation('operation-direct')),
    );

    expect(result).toMatchObject({
      state: 'prepared',
      needsSwap: false,
      quoteId: QUOTE_MELT_FIXTURE.quoteId,
      inputProofSecrets: ['input-1', 'input-2'],
    });
    expect(result.amount).toEqual(Amount.from(100));
    expect(result.fee_reserve).toEqual(Amount.from(10));
    expect(result.swap_fee).toEqual(Amount.zero());
    expect(harness.mocks.selectProofsToSend).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      { amount: Amount.from(110), unit: 'sat' },
      true,
    );
    expect(harness.mocks.reserveProofs).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['input-1', 'input-2'],
      'operation-direct',
      { unit: 'sat' },
    );
  });

  it('uses the fee reserve supplied by the payment-method hook', async () => {
    harness.hooks.getFeeReserveForQuote.mockReturnValueOnce(Amount.from(25));
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('input-1', 75),
      makeQuoteMeltProof('input-2', 50),
    ]);

    const result = await harness.handler.prepare(harness.buildPrepareContext());

    expect(result.fee_reserve).toEqual(Amount.from(25));
    expect(harness.mocks.selectProofsToSend).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      { amount: Amount.from(125), unit: 'sat' },
      true,
    );
  });

  it('selects fee-aware proofs and records their full input amount', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('input-1', 60),
      makeQuoteMeltProof('input-2', 50),
      makeQuoteMeltProof('input-3', 1),
    ]);

    const result = await harness.handler.prepare(harness.buildPrepareContext());

    expect(result.needsSwap).toBe(false);
    expect(result.inputAmount).toEqual(Amount.from(111));
    expect(result.inputProofSecrets).toEqual(['input-1', 'input-2', 'input-3']);
  });

  it('rejects selections that do not cover the quoted amount and reserve', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValue([
      makeQuoteMeltProof('input-1', 60),
      makeQuoteMeltProof('input-2', 49),
    ]);

    await expect(harness.handler.prepare(harness.buildPrepareContext())).rejects.toThrow(
      ProofValidationError,
    );
    expect(harness.mocks.reserveProofs).not.toHaveBeenCalled();
  });

  it('creates blank outputs for the maximum possible change', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('input-1', 70),
      makeQuoteMeltProof('input-2', 50),
    ]);

    await harness.handler.prepare(harness.buildPrepareContext());

    expect(harness.mocks.createBlankOutputs).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, {
      amount: Amount.from(20),
      unit: 'sat',
    });
  });

  it('normalizes custom units for selection, reservation, and change outputs', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('usd-input-1', 60),
      makeQuoteMeltProof('usd-input-2', 60),
    ]);
    const operation = harness.makeInitOperation('operation-usd', { unit: 'usd' });

    const result = await harness.handler.prepare(
      harness.buildPrepareContext(operation, { quote: 'quote-usd', unit: 'USD' }),
    );

    expect(result.unit).toBe('usd');
    expect(result.quoteId).toBe('quote-usd');
    expect(harness.mocks.selectProofsToSend).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      { amount: Amount.from(110), unit: 'usd' },
      true,
    );
    expect(harness.mocks.reserveProofs).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['usd-input-1', 'usd-input-2'],
      'operation-usd',
      { unit: 'usd' },
    );
    expect(harness.mocks.createBlankOutputs).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, {
      amount: Amount.from(20),
      unit: 'usd',
    });
  });

  it('rejects quote unit mismatches before selecting proofs', async () => {
    const operation = harness.makeInitOperation('operation-usd', { unit: 'usd' });

    await expect(
      harness.handler.prepare(harness.buildPrepareContext(operation, { unit: 'sat' })),
    ).rejects.toThrow('Unit mismatch');
    expect(harness.mocks.selectProofsToSend).not.toHaveBeenCalled();
  });

  it('uses a pre-created quote without invoking remote quote creation', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValueOnce([
      makeQuoteMeltProof('input-1', 55),
      makeQuoteMeltProof('input-2', 55),
    ]);
    const operation = harness.makeInitOperation('operation-with-quote', {
      quoteId: QUOTE_MELT_FIXTURE.quoteId,
      methodData: { invoice: QUOTE_MELT_FIXTURE.invoice, amountSats: Amount.from(1_000) },
    });

    await harness.handler.prepare(harness.buildPrepareContext(operation));

    expect(harness.hooks.createRemoteQuote).not.toHaveBeenCalled();
  });

  it.each([
    [120, false],
    [121, true],
  ])(
    'uses the 10%% excess boundary: selected amount %i => needsSwap %p',
    async (amount, needsSwap) => {
      harness.mocks.selectProofsToSend.mockResolvedValue([makeQuoteMeltProof('input-1', amount)]);

      const result = await harness.handler.prepare(harness.buildPrepareContext());

      expect(result.needsSwap).toBe(needsSwap);
    },
  );

  it('prepares swap outputs and reserves the selected proofs when excess is high', async () => {
    harness.mocks.selectProofsToSend.mockResolvedValue([
      makeQuoteMeltProof('input-1', 80),
      makeQuoteMeltProof('input-2', 50),
    ]);

    const result = await harness.handler.prepare(
      harness.buildPrepareContext(harness.makeInitOperation('operation-swap')),
    );

    expect(result.needsSwap).toBe(true);
    expect(result.swap_fee).toEqual(Amount.from(1));
    expect(result.swapOutputData).toBeDefined();
    expect(harness.mocks.selectProofsToSend).toHaveBeenCalledTimes(2);
    expect(harness.mocks.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      {
        keep: { amount: Amount.from(19), unit: 'sat' },
        send: { amount: Amount.from(110), unit: 'sat' },
      },
      { includeFees: true },
    );
    expect(harness.mocks.reserveProofs).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['input-1', 'input-2'],
      'operation-swap',
      { unit: 'sat' },
    );
  });

  it('rejects swap selections that cannot also pay the swap input fee', async () => {
    harness.mocks.getFeesForProofs.mockReturnValue(Amount.from(25));
    harness.mocks.selectProofsToSend.mockResolvedValue([
      makeQuoteMeltProof('input-1', 80),
      makeQuoteMeltProof('input-2', 50),
    ]);

    await expect(harness.handler.prepare(harness.buildPrepareContext())).rejects.toThrow(
      ProofValidationError,
    );
    expect(harness.mocks.reserveProofs).not.toHaveBeenCalled();
  });
});
