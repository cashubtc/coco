import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MintOperationError } from '../../models/Error';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltChange,
  makeQuoteMeltCoreProof,
  makeQuoteMeltOutputData,
  QUOTE_MELT_FIXTURE as f,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler recovery', () => {
  let h: QuoteMeltHandlerHarness;
  const swapData = () => makeQuoteMeltOutputData([{ secret: 'keep-1' }], [{ secret: 'send-1' }]);
  const swapOperation = () =>
    h.makeExecutingOperation({
      needsSwap: true,
      inputProofSecrets: ['input-1'],
      swapOutputData: swapData(),
    });

  beforeEach(() => {
    h = createQuoteMeltHandlerHarness();
  });

  it('finalizes a paid operation with its settlement data and change', async () => {
    const change = [makeQuoteMeltChange(5)];
    const result = await h.recover({
      operation: h.makeExecutingOperation({
        id: 'paid',
        inputProofSecrets: ['input-1'],
      }),
      state: 'PAID',
      response: { state: 'PAID', change, payment_preimage: 'preimage-recovered' },
    });

    if (result.status !== 'PAID') throw new Error('Expected paid recovery');
    expect(result.finalized.changeAmount).toEqual(Amount.from(5));
    expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
    expect(result.finalized.finalizedData).toEqual({ preimage: 'preimage-recovered' });
    expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['input-1'], 'spent');
    expect(h.mocks.unblindAndSaveChangeProofs).toHaveBeenCalledWith(
      f.mintUrl,
      expect.any(Array),
      change,
      { unit: 'sat', createdByOperationId: 'paid' },
    );
  });

  it('calculates paid swap fees from the proofs sent to melt', async () => {
    const result = await h.recover({
      state: 'PAID',
      operation: h.makeExecutingOperation({
        needsSwap: true,
        amount: Amount.from(55),
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData: makeQuoteMeltOutputData(
          [{ secret: 'keep-output', amount: 140 }],
          [{ secret: 'send-output', amount: 60 }],
        ),
      }),
      response: { state: 'PAID', change: [] },
    });

    if (result.status !== 'PAID') throw new Error('Expected paid recovery');
    expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
    expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['send-output'], 'spent');
  });

  it('keeps a remotely pending operation pending', async () => {
    expect((await h.recover({ state: 'PENDING' })).status).toBe('PENDING');
    expect(h.hooks.checkMeltQuote).not.toHaveBeenCalled();
  });

  it('restores original proofs for an unpaid direct melt', async () => {
    expect((await h.recover({ state: 'UNPAID' })).status).toBe('FAILED');
    expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, ['input-1', 'input-2']);
    expect(h.mocks.checkProofStates).not.toHaveBeenCalled();
  });

  it('restores original proofs when a required swap never happened', async () => {
    expect((await h.recover({ operation: swapOperation(), state: 'UNPAID' })).status).toBe(
      'FAILED',
    );
    expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, ['input-1']);
  });

  it('restores locally persisted send proofs after a completed swap', async () => {
    h.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);
    h.mocks.getProofsByOperationId.mockResolvedValueOnce([makeQuoteMeltCoreProof('send-1', 110)]);

    expect((await h.recover({ operation: swapOperation(), state: 'UNPAID' })).status).toBe(
      'FAILED',
    );
    expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, ['send-1']);
    expect(h.mocks.recoverProofsFromOutputData).not.toHaveBeenCalled();
  });

  it('recovers unpersisted swap outputs from the mint', async () => {
    const operation = swapOperation();
    h.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);

    expect((await h.recover({ operation, state: 'UNPAID' })).status).toBe('FAILED');
    expect(h.mocks.recoverProofsFromOutputData).toHaveBeenCalledWith(
      f.mintUrl,
      operation.swapOutputData,
      { unit: 'sat', createdByOperationId: operation.id },
    );
    expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['input-1'], 'spent');
  });

  it('warns if recovered swap inputs cannot be marked spent', async () => {
    h.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);
    h.mocks.setProofState.mockRejectedValueOnce(new Error('DB error'));

    expect((await h.recover({ operation: swapOperation(), state: 'UNPAID' })).status).toBe(
      'FAILED',
    );
    expect(h.mocks.warn).toHaveBeenCalledWith('Failed to mark input proofs as spent', {
      operationId: 'operation-1',
    });
  });

  it('treats mint error 20007 as an expired unpaid quote', async () => {
    h.hooks.checkMeltQuoteState.mockRejectedValueOnce(
      new MintOperationError(20007, 'Quote expired'),
    );

    expect((await h.recover()).status).toBe('FAILED');
    expect(h.mocks.restoreProofsToReady).toHaveBeenCalled();
  });

  it('rethrows other quote-state failures', async () => {
    const error = new Error('Mint unavailable');
    h.hooks.checkMeltQuoteState.mockRejectedValueOnce(error);
    await expect(h.recover()).rejects.toBe(error);
  });

  it('rejects an unexpected remote state', async () => {
    await expect(h.recover({ state: 'INVALID' })).rejects.toThrow(
      `Unexpected melt response state: INVALID for quote ${f.quoteId}`,
    );
  });
});
