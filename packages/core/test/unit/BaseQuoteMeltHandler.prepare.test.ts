import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ProofValidationError } from '../../models/Error';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltProof,
  QUOTE_MELT_FIXTURE as f,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler prepare', () => {
  let h: QuoteMeltHandlerHarness;
  const proofs = (...amounts: number[]) =>
    amounts.map((amount, index) => makeQuoteMeltProof(`input-${index + 1}`, amount));

  beforeEach(() => {
    h = createQuoteMeltHandlerHarness();
  });

  it('prepares and reserves a fee-aware direct melt from the supplied quote', async () => {
    const result = await h.prepare({
      operation: h.makeInitOperation({ id: 'direct' }),
      proofs: proofs(60, 50, 1),
    });

    expect(result).toMatchObject({
      state: 'prepared',
      needsSwap: false,
      quoteId: f.quoteId,
      inputProofSecrets: ['input-1', 'input-2', 'input-3'],
    });
    expect(result.inputAmount).toEqual(Amount.from(111));
    expect(result.swap_fee).toEqual(Amount.zero());
    expect(h.mocks.selectProofsToSend).toHaveBeenCalledWith(
      f.mintUrl,
      { amount: Amount.from(110), unit: 'sat' },
      true,
    );
    expect(h.mocks.reserveProofs).toHaveBeenCalledWith(
      f.mintUrl,
      result.inputProofSecrets,
      'direct',
      { unit: 'sat' },
    );
  });

  it('uses the payment-method fee reserve hook', async () => {
    h.hooks.getFeeReserveForQuote.mockReturnValueOnce(Amount.from(25));
    const result = await h.prepare({ proofs: proofs(125) });

    expect(result.fee_reserve).toEqual(Amount.from(25));
    expect(h.mocks.selectProofsToSend).toHaveBeenCalledWith(
      f.mintUrl,
      { amount: Amount.from(125), unit: 'sat' },
      true,
    );
  });

  it('rejects selections that do not cover the amount and reserve', async () => {
    await expect(h.prepare({ proofs: proofs(109) })).rejects.toThrow(ProofValidationError);
    expect(h.mocks.reserveProofs).not.toHaveBeenCalled();
  });

  it('creates outputs for the maximum possible change', async () => {
    await h.prepare({ proofs: proofs(120) });
    expect(h.mocks.createBlankOutputs).toHaveBeenCalledWith(f.mintUrl, {
      amount: Amount.from(20),
      unit: 'sat',
    });
  });

  it('normalizes custom units throughout preparation', async () => {
    const result = await h.prepare({
      operation: h.makeInitOperation({ id: 'usd', unit: 'usd' }),
      quote: { quote: 'quote-usd', unit: 'USD' },
      proofs: proofs(120),
    });

    expect(result).toMatchObject({ unit: 'usd', quoteId: 'quote-usd' });
    expect(h.mocks.reserveProofs).toHaveBeenCalledWith(f.mintUrl, ['input-1'], 'usd', {
      unit: 'usd',
    });
    expect(h.mocks.createBlankOutputs).toHaveBeenCalledWith(f.mintUrl, {
      amount: Amount.from(20),
      unit: 'usd',
    });
  });

  it('rejects unit mismatches before proof selection', async () => {
    await expect(
      h.prepare({ operation: h.makeInitOperation({ unit: 'usd' }), quote: { unit: 'sat' } }),
    ).rejects.toThrow('Unit mismatch');
    expect(h.mocks.selectProofsToSend).not.toHaveBeenCalled();
  });

  it('does not create a second remote quote during preparation', async () => {
    await h.prepare({
      operation: h.makeInitOperation({
        quoteId: f.quoteId,
        methodData: { invoice: f.invoice, amountSats: Amount.from(1_000) },
      }),
    });
    expect(h.hooks.createRemoteQuote).not.toHaveBeenCalled();
  });

  it.each([
    [120, false],
    [121, true],
  ])('uses the 10%% excess boundary: %i => swap %p', async (amount, needsSwap) => {
    expect((await h.prepare({ proofs: proofs(amount) })).needsSwap).toBe(needsSwap);
  });

  it('prepares exact send/keep outputs for a swap melt', async () => {
    const result = await h.prepare({
      operation: h.makeInitOperation({ id: 'swap' }),
      proofs: proofs(80, 50),
    });

    expect(result.needsSwap).toBe(true);
    expect(result.swap_fee).toEqual(Amount.from(1));
    expect(h.mocks.selectProofsToSend).toHaveBeenCalledTimes(2);
    expect(h.mocks.reserveProofs).toHaveBeenCalledWith(f.mintUrl, ['input-1', 'input-2'], 'swap', {
      unit: 'sat',
    });
    expect(h.mocks.createOutputsAndIncrementCounters).toHaveBeenCalledWith(
      f.mintUrl,
      {
        keep: { amount: Amount.from(19), unit: 'sat' },
        send: { amount: Amount.from(110), unit: 'sat' },
      },
      { includeFees: true },
    );
  });

  it('rejects swap selections that cannot also pay their input fee', async () => {
    h.mocks.getFeesForProofs.mockReturnValue(Amount.from(25));
    await expect(h.prepare({ proofs: proofs(80, 50) })).rejects.toThrow(ProofValidationError);
    expect(h.mocks.reserveProofs).not.toHaveBeenCalled();
  });
});
