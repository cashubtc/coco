import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltChange,
  makeQuoteMeltCoreProof,
  makeQuoteMeltOutputData,
  makeQuoteMeltProof,
  QUOTE_MELT_FIXTURE,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler settlement', () => {
  let harness: QuoteMeltHandlerHarness;

  beforeEach(() => {
    harness = createQuoteMeltHandlerHarness();
  });

  describe('execute', () => {
    it('finalizes a paid direct melt and calculates its settlement amounts', async () => {
      const inputProofs = [
        makeQuoteMeltCoreProof('input-1', 60),
        makeQuoteMeltCoreProof('input-2', 50),
      ];
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);

      const result = await harness.handler.execute(harness.buildExecuteContext());

      expect(result.status).toBe('PAID');
      if (result.status !== 'PAID') throw new Error('Expected a paid execution');
      expect(result.finalized.changeAmount).toEqual(Amount.zero());
      expect(result.finalized.effectiveFee).toEqual(Amount.from(10));
      expect(result.finalized.finalizedData).toEqual({ preimage: 'preimage-123' });
      expect(harness.mocks.setProofState).toHaveBeenCalledWith(
        QUOTE_MELT_FIXTURE.mintUrl,
        ['input-1', 'input-2'],
        'inflight',
      );
      expect(harness.mocks.setProofState).toHaveBeenCalledWith(
        QUOTE_MELT_FIXTURE.mintUrl,
        ['input-1', 'input-2'],
        'spent',
      );
      expect(harness.hooks.executeMelt).toHaveBeenCalledWith(
        expect.anything(),
        inputProofs,
        expect.any(Array),
        QUOTE_MELT_FIXTURE.quoteId,
      );
    });

    it('leaves proofs inflight when the mint reports pending', async () => {
      const inputProofs = [makeQuoteMeltCoreProof('input-1', 110)];
      const operation = harness.makeExecutingOperation('operation-pending', {
        inputProofSecrets: ['input-1'],
      });
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);
      harness.hooks.executeMelt.mockResolvedValueOnce({ state: 'PENDING' });

      const result = await harness.handler.execute(
        harness.buildExecuteContext(operation, inputProofs),
      );

      expect(result.status).toBe('PENDING');
      if (result.status !== 'PENDING') throw new Error('Expected a pending execution');
      expect(result.pending.state).toBe('pending');
      expect(harness.mocks.restoreProofsToReady).not.toHaveBeenCalled();
    });

    it('restores direct melt proofs when the mint reports unpaid', async () => {
      const inputProofs = [
        makeQuoteMeltCoreProof('input-1', 60),
        makeQuoteMeltCoreProof('input-2', 50),
      ];
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);
      harness.hooks.executeMelt.mockResolvedValueOnce({ state: 'UNPAID' });

      const result = await harness.handler.execute(harness.buildExecuteContext());

      expect(result.status).toBe('FAILED');
      expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
        'input-1',
        'input-2',
      ]);
    });

    it('rejects execution when not all reserved input proofs can be found', async () => {
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce([
        makeQuoteMeltCoreProof('input-1', 60),
      ]);

      await expect(harness.handler.execute(harness.buildExecuteContext())).rejects.toThrow(
        'Could not find all input proofs',
      );
      expect(harness.hooks.executeMelt).not.toHaveBeenCalled();
    });

    it('swaps excess input before melting and persists both sides with their states', async () => {
      const inputProofs = [makeQuoteMeltCoreProof('input-1', 200)];
      const operation = harness.makeExecutingOperation('operation-swap', {
        needsSwap: true,
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData: makeQuoteMeltOutputData(
          [{ secret: 'keep-output', amount: 90 }],
          [{ secret: 'send-output', amount: 110 }],
        ),
      });
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);

      await harness.handler.execute(harness.buildExecuteContext(operation, inputProofs));

      expect(harness.mocks.send).toHaveBeenCalledWith(
        Amount.from(110),
        inputProofs,
        undefined,
        expect.objectContaining({
          send: { type: 'custom', data: expect.any(Array) },
          keep: { type: 'custom', data: expect.any(Array) },
        }),
      );
      expect(harness.mocks.setProofState).toHaveBeenNthCalledWith(
        1,
        QUOTE_MELT_FIXTURE.mintUrl,
        ['input-1'],
        'inflight',
      );
      expect(harness.mocks.setProofState).toHaveBeenNthCalledWith(
        2,
        QUOTE_MELT_FIXTURE.mintUrl,
        ['input-1'],
        'spent',
      );
      expect(harness.mocks.saveProofs).toHaveBeenCalledWith(
        QUOTE_MELT_FIXTURE.mintUrl,
        expect.arrayContaining([
          expect.objectContaining({ secret: 'keep-1', state: 'ready' }),
          expect.objectContaining({ secret: 'send-1', state: 'inflight' }),
        ]),
      );
      expect(harness.hooks.executeMelt.mock.calls[0]?.[1]).toEqual([
        makeQuoteMeltProof('send-1', 60),
      ]);
    });

    it('calculates swap settlement fees from the proofs sent to melt', async () => {
      const inputProofs = [makeQuoteMeltCoreProof('input-1', 200)];
      const operation = harness.makeExecutingOperation('operation-swap-fee', {
        needsSwap: true,
        amount: Amount.from(55),
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData: makeQuoteMeltOutputData(
          [{ secret: 'keep-output', amount: 140 }],
          [{ secret: 'send-output', amount: 60 }],
        ),
      });
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);
      harness.hooks.executeMelt.mockResolvedValueOnce({ state: 'PAID', change: [] });

      const result = await harness.handler.execute(
        harness.buildExecuteContext(operation, inputProofs),
      );

      expect(result.status).toBe('PAID');
      if (result.status !== 'PAID') throw new Error('Expected a paid execution');
      expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
    });

    it('requires prepared swap output data before executing a swap', async () => {
      const inputProofs = [makeQuoteMeltCoreProof('input-1', 200)];
      const operation = harness.makeExecutingOperation('operation-swap-missing-data', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        swapOutputData: undefined,
      });
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);

      await expect(
        harness.handler.execute(harness.buildExecuteContext(operation, inputProofs)),
      ).rejects.toThrow('Swap is required, but swap output data is missing');
    });

    it('unblinds returned change and subtracts it from the effective fee', async () => {
      const inputProofs = [makeQuoteMeltCoreProof('input-1', 110)];
      const operation = harness.makeExecutingOperation('operation-change', {
        inputProofSecrets: ['input-1'],
      });
      const change = [makeQuoteMeltChange(10)];
      harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);
      harness.hooks.executeMelt.mockResolvedValueOnce({ state: 'PAID', change });

      const result = await harness.handler.execute(
        harness.buildExecuteContext(operation, inputProofs),
      );

      expect(harness.mocks.unblindAndSaveChangeProofs).toHaveBeenCalledWith(
        QUOTE_MELT_FIXTURE.mintUrl,
        expect.any(Array),
        change,
        { unit: 'sat', createdByOperationId: 'operation-change' },
      );
      expect(result.status).toBe('PAID');
      if (result.status !== 'PAID') throw new Error('Expected a paid execution');
      expect(result.finalized.changeAmount).toEqual(Amount.from(10));
      expect(result.finalized.effectiveFee).toEqual(Amount.zero());
    });

    it.each([
      ['empty', []],
      ['undefined', undefined],
    ] as Array<[string, Array<ReturnType<typeof makeQuoteMeltChange>> | undefined]>)(
      'does not try to unblind %s change signatures',
      async (_case, change) => {
        const inputProofs = [makeQuoteMeltCoreProof('input-1', 110)];
        const operation = harness.makeExecutingOperation('operation-no-change', {
          inputProofSecrets: ['input-1'],
        });
        harness.mocks.getProofsByOperationId.mockResolvedValueOnce(inputProofs);
        harness.hooks.executeMelt.mockResolvedValueOnce({ state: 'PAID', change });

        const result = await harness.handler.execute(
          harness.buildExecuteContext(operation, inputProofs),
        );

        expect(result.status).toBe('PAID');
        expect(harness.mocks.unblindAndSaveChangeProofs).not.toHaveBeenCalled();
      },
    );
  });

  describe('finalize', () => {
    it('uses complete persisted settlement data without checking the mint again', async () => {
      const change = [makeQuoteMeltChange(5)];
      const operation = harness.makePendingOperation('operation-canonical', {
        inputProofSecrets: ['input-1'],
      });
      const quote = harness.makeCanonicalQuote({
        state: 'PAID',
        change,
        payment_preimage: 'preimage-canonical',
      });

      const result = await harness.handler.finalize(harness.buildFinalizeContext(operation, quote));

      expect(harness.hooks.checkMeltQuote).not.toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-canonical' },
      });
    });

    it('fetches full settlement data when no canonical quote is supplied', async () => {
      const change = [makeQuoteMeltChange(5)];
      harness.hooks.checkMeltQuote.mockResolvedValueOnce({
        state: 'PAID',
        change,
        payment_preimage: 'preimage-remote',
      });

      const result = await harness.handler.finalize(harness.buildFinalizeContext());

      expect(harness.hooks.checkMeltQuote).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-remote' },
      });
    });

    it('fetches full settlement data when a paid canonical quote omits change', async () => {
      const change = [makeQuoteMeltChange(5)];
      const quote = harness.makeCanonicalQuote({
        state: 'PAID',
        change: undefined,
        payment_preimage: 'preimage-partial',
      });
      harness.hooks.checkMeltQuote.mockResolvedValueOnce({
        state: 'PAID',
        change,
        payment_preimage: 'preimage-remote',
      });

      const result = await harness.handler.finalize(harness.buildFinalizeContext(undefined, quote));

      expect(harness.hooks.checkMeltQuote).toHaveBeenCalledTimes(1);
      expect(result.finalizedData).toEqual({ preimage: 'preimage-remote' });
      expect(result.changeAmount).toEqual(Amount.from(5));
    });

    it('rejects a supplied non-paid canonical quote without rechecking the mint', async () => {
      const quote = harness.makeCanonicalQuote({ state: 'PENDING', change: undefined });

      await expect(
        harness.handler.finalize(harness.buildFinalizeContext(undefined, quote)),
      ).rejects.toThrow(
        `Cannot finalize: melt quote ${QUOTE_MELT_FIXTURE.quoteId} is PENDING, expected PAID`,
      );
      expect(harness.hooks.checkMeltQuote).not.toHaveBeenCalled();
    });

    it('rejects a fetched settlement that is not paid', async () => {
      harness.hooks.checkMeltQuote.mockResolvedValueOnce({ state: 'PENDING' });

      await expect(harness.handler.finalize(harness.buildFinalizeContext())).rejects.toThrow(
        `Cannot finalize: melt quote ${QUOTE_MELT_FIXTURE.quoteId} is PENDING, expected PAID`,
      );
    });

    it('marks swap send proofs spent and calculates fees from their output amount', async () => {
      const operation = harness.makePendingOperation('operation-finalize-swap', {
        needsSwap: true,
        amount: Amount.from(55),
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData: makeQuoteMeltOutputData(
          [{ secret: 'keep-output', amount: 140 }],
          [{ secret: 'send-output', amount: 60 }],
        ),
      });
      harness.hooks.checkMeltQuote.mockResolvedValueOnce({ state: 'PAID', change: [] });

      const result = await harness.handler.finalize(harness.buildFinalizeContext(operation));

      expect(harness.mocks.setProofState).toHaveBeenCalledWith(
        QUOTE_MELT_FIXTURE.mintUrl,
        ['send-output'],
        'spent',
      );
      expect(result).toEqual({
        changeAmount: Amount.zero(),
        effectiveFee: Amount.from(5),
        finalizedData: undefined,
      });
    });
  });

  describe('pending state', () => {
    it.each([
      ['PAID', 'finalize'],
      ['PENDING', 'stay_pending'],
      ['UNPAID', 'rollback'],
    ] as const)('maps %s to %s', async (remoteState, expected) => {
      harness.hooks.checkMeltQuoteState.mockResolvedValueOnce(remoteState);

      await expect(harness.handler.checkPending(harness.buildPendingContext())).resolves.toBe(
        expected,
      );
    });

    it('uses the canonical quote state when one is supplied', async () => {
      const quote = harness.makeCanonicalQuote({ state: 'PENDING' });

      await expect(
        harness.handler.checkPending(harness.buildPendingContext(undefined, quote)),
      ).resolves.toBe('stay_pending');
      expect(harness.hooks.checkMeltQuoteState).not.toHaveBeenCalled();
    });

    it('rejects an unexpected remote state', async () => {
      harness.hooks.checkMeltQuoteState.mockResolvedValueOnce(
        'UNKNOWN' as Parameters<typeof harness.hooks.checkMeltQuoteState.mockResolvedValueOnce>[0],
      );

      await expect(harness.handler.checkPending(harness.buildPendingContext())).rejects.toThrow(
        `Unexpected melt quote state: UNKNOWN for quote ${QUOTE_MELT_FIXTURE.quoteId}`,
      );
    });
  });

  describe('rollback', () => {
    it('restores original input proofs for a direct melt', async () => {
      await harness.handler.rollback(harness.buildRollbackContext());

      expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
        'input-1',
        'input-2',
      ]);
    });

    it('restores swap send proofs and releases original inputs for a swap melt', async () => {
      const operation = harness.makePreparedOperation('operation-rollback-swap', {
        needsSwap: true,
        inputProofSecrets: ['input-1'],
        swapOutputData: makeQuoteMeltOutputData(
          [{ secret: 'keep-1' }],
          [{ secret: 'send-1' }, { secret: 'send-2' }],
        ),
      });

      await harness.handler.rollback(harness.buildRollbackContext(operation));

      expect(harness.mocks.restoreProofsToReady).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
        'send-1',
        'send-2',
      ]);
      expect(harness.mocks.releaseProofs).toHaveBeenCalledWith(QUOTE_MELT_FIXTURE.mintUrl, [
        'input-1',
      ]);
    });
  });
});
