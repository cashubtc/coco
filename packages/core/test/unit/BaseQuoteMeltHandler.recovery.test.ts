import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MintOperationError } from '../../models/Error';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltChange,
  makeQuoteMeltCoreProof,
  makeQuoteMeltOutputData,
  QUOTE_MELT_FIXTURE,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler recovery', () => {
  let harness: QuoteMeltHandlerHarness;

  beforeEach(() => {
    harness = createQuoteMeltHandlerHarness();
  });

  it('finalizes an executing operation whose quote was paid', async () => {
    const operation = harness.makeExecutingOperation('operation-paid', {
      inputProofSecrets: ['input-1'],
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('PAID');
    harness.hooks.checkMeltQuote.mockResolvedValueOnce({
      state: 'PAID',
      change: [],
      payment_preimage: 'preimage-recovered',
    });

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid recovery');
    expect(result.finalized.changeAmount).toEqual(Amount.zero());
    expect(result.finalized.effectiveFee).toEqual(Amount.from(10));
    expect(result.finalized.finalizedData).toEqual({ preimage: 'preimage-recovered' });
    expect(harness.mocks.setProofState).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['input-1'],
      'spent',
    );
  });

  it('restores returned change while recovering a paid operation', async () => {
    const operation = harness.makeExecutingOperation('operation-paid-change', {
      inputProofSecrets: ['input-1'],
    });
    const change = [makeQuoteMeltChange(5)];
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('PAID');
    harness.hooks.checkMeltQuote.mockResolvedValueOnce({ state: 'PAID', change });

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(harness.mocks.unblindAndSaveChangeProofs).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      expect.any(Array),
      change,
      { unit: 'sat', createdByOperationId: 'operation-paid-change' },
    );
    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid recovery');
    expect(result.finalized.changeAmount).toEqual(Amount.from(5));
    expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
  });

  it('calculates recovered swap fees from the proofs sent to melt', async () => {
    const operation = harness.makeExecutingOperation('operation-paid-swap', {
      needsSwap: true,
      amount: Amount.from(55),
      inputAmount: Amount.from(200),
      inputProofSecrets: ['input-1'],
      swapOutputData: makeQuoteMeltOutputData(
        [{ secret: 'keep-output', amount: 140 }],
        [{ secret: 'send-output', amount: 60 }],
      ),
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('PAID');
    harness.hooks.checkMeltQuote.mockResolvedValueOnce({ state: 'PAID', change: [] });

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('PAID');
    if (result.status !== 'PAID') throw new Error('Expected paid recovery');
    expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
    expect(harness.mocks.setProofState).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['send-output'],
      'spent',
    );
  });

  it('returns a pending result while the quote is still pending', async () => {
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('PENDING');

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext());

    expect(result.status).toBe('PENDING');
    expect(harness.hooks.checkMeltQuote).not.toHaveBeenCalled();
  });

  it('restores original proofs for an unpaid direct melt', async () => {
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('UNPAID');

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext());

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
      'input-1',
      'input-2',
    ]);
    expect(harness.mocks.checkProofStates).not.toHaveBeenCalled();
  });

  it('restores original proofs when a required swap never happened', async () => {
    const operation = harness.makeExecutingOperation('operation-swap-not-run', {
      needsSwap: true,
      inputProofSecrets: ['input-1'],
      swapOutputData: makeQuoteMeltOutputData([{ secret: 'keep-1' }], [{ secret: 'send-1' }]),
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('UNPAID');
    harness.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'UNSPENT', Y: 'y1' }]);

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
      'input-1',
    ]);
  });

  it('restores locally persisted send proofs when the swap happened', async () => {
    const operation = harness.makeExecutingOperation('operation-local-swap', {
      needsSwap: true,
      inputProofSecrets: ['input-1'],
      swapOutputData: makeQuoteMeltOutputData(
        [{ secret: 'keep-1' }],
        [{ secret: 'send-1' }, { secret: 'send-2' }],
      ),
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('UNPAID');
    harness.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);
    harness.mocks.getProofsByOperationId.mockResolvedValueOnce([
      makeQuoteMeltCoreProof('send-1', 60, { createdByOperationId: 'operation-local-swap' }),
      makeQuoteMeltCoreProof('send-2', 50, { createdByOperationId: 'operation-local-swap' }),
    ]);

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
      'send-1',
      'send-2',
    ]);
    expect(harness.mocks.recoverProofsFromOutputData).not.toHaveBeenCalled();
  });

  it('recovers swap outputs from the mint when they were not persisted locally', async () => {
    const swapOutputData = makeQuoteMeltOutputData([{ secret: 'keep-1' }], [{ secret: 'send-1' }]);
    const operation = harness.makeExecutingOperation('operation-missing-swap', {
      needsSwap: true,
      inputProofSecrets: ['input-1'],
      swapOutputData,
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('UNPAID');
    harness.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);
    harness.mocks.getProofsByOperationId.mockResolvedValueOnce([]);

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.recoverProofsFromOutputData).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      swapOutputData,
      { unit: 'sat', createdByOperationId: 'operation-missing-swap' },
    );
    expect(harness.mocks.setProofState).toHaveBeenCalledWith(
      QUOTE_MELT_FIXTURE.mintUrl,
      ['input-1'],
      'spent',
    );
  });

  it('warns but completes recovery if marking recovered swap inputs spent fails', async () => {
    const operation = harness.makeExecutingOperation('operation-state-failure', {
      needsSwap: true,
      inputProofSecrets: ['input-1'],
      swapOutputData: makeQuoteMeltOutputData([{ secret: 'keep-1' }], [{ secret: 'send-1' }]),
    });
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce('UNPAID');
    harness.mocks.checkProofStates.mockResolvedValueOnce([{ state: 'SPENT', Y: 'y1' }]);
    harness.mocks.getProofsByOperationId.mockResolvedValueOnce([]);
    harness.mocks.setProofState.mockRejectedValueOnce(new Error('DB error'));

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext(operation));

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.warn).toHaveBeenCalledWith('Failed to mark input proofs as spent', {
      operationId: 'operation-state-failure',
    });
  });

  it('treats mint error 20007 as an expired unpaid quote', async () => {
    harness.hooks.checkMeltQuoteState.mockRejectedValueOnce(
      new MintOperationError(20007, 'Quote expired'),
    );

    const result = await harness.handler.recoverExecuting(harness.buildRecoverContext());

    expect(result.status).toBe('FAILED');
    expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
      'input-1',
      'input-2',
    ]);
  });

  it('rethrows other quote-state failures', async () => {
    const error = new Error('Mint unavailable');
    harness.hooks.checkMeltQuoteState.mockRejectedValueOnce(error);

    await expect(harness.handler.recoverExecuting(harness.buildRecoverContext())).rejects.toBe(
      error,
    );
  });

  it('rejects an unexpected remote state', async () => {
    harness.hooks.checkMeltQuoteState.mockResolvedValueOnce(
      'INVALID' as Parameters<typeof harness.hooks.checkMeltQuoteState.mockResolvedValueOnce>[0],
    );

    await expect(harness.handler.recoverExecuting(harness.buildRecoverContext())).rejects.toThrow(
      `Unexpected melt response state: INVALID for quote ${QUOTE_MELT_FIXTURE.quoteId}`,
    );
  });
});
