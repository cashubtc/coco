import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { deserializeOutputData } from '../../utils';
import {
  createQuoteMeltHandlerHarness,
  makeQuoteMeltChange,
  makeQuoteMeltCoreProof,
  makeQuoteMeltOutputData,
  makeQuoteMeltProof,
  QUOTE_MELT_FIXTURE as f,
  type QuoteMeltHandlerHarness,
} from '../fixtures/QuoteMeltHandlerHarness';

describe('BaseQuoteMeltHandler settlement', () => {
  let h: QuoteMeltHandlerHarness;

  beforeEach(() => {
    h = createQuoteMeltHandlerHarness();
  });

  const swapData = (keep: number, send: number) =>
    makeQuoteMeltOutputData(
      [{ secret: 'keep-output', amount: keep }],
      [{ secret: 'send-output', amount: send }],
    );

  describe('execute', () => {
    it('finalizes a paid direct melt with settlement amounts', async () => {
      const result = await h.execute();

      expect(result.status).toBe('PAID');
      if (result.status !== 'PAID') throw new Error('Expected paid execution');
      expect(result.finalized).toMatchObject({ finalizedData: { preimage: 'preimage-123' } });
      expect(result.finalized.changeAmount).toEqual(Amount.zero());
      expect(result.finalized.effectiveFee).toEqual(Amount.from(10));
      expect(h.mocks.setProofState).toHaveBeenCalledWith(
        f.mintUrl,
        ['input-1', 'input-2'],
        'inflight',
      );
      expect(h.mocks.setProofState).toHaveBeenCalledWith(
        f.mintUrl,
        ['input-1', 'input-2'],
        'spent',
      );
    });

    it.each([
      ['PENDING', 'PENDING', false],
      ['UNPAID', 'FAILED', true],
    ] as const)('maps a %s response to %s', async (state, status, restores) => {
      const result = await h.execute({ response: { state } });

      expect(result.status).toBe(status);
      expect(h.mocks.restoreProofsToReady).toHaveBeenCalledTimes(restores ? 1 : 0);
      if (restores) {
        expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, [
          'input-1',
          'input-2',
        ]);
      }
    });

    it('requires every reserved input proof', async () => {
      await expect(h.execute({ proofs: [makeQuoteMeltCoreProof('input-1', 60)] })).rejects.toThrow(
        'Could not find all input proofs',
      );
      expect(h.hooks.executeMelt).not.toHaveBeenCalled();
    });

    it('swaps excess input and persists its keep/send proofs with distinct states', async () => {
      const input = [makeQuoteMeltCoreProof('input-1', 200)];
      const operation = h.makeExecutingOperation({
        id: 'swap',
        needsSwap: true,
        inputAmount: Amount.from(200),
        inputProofSecrets: ['input-1'],
        swapOutputData: swapData(90, 110),
      });

      await h.execute({ operation, proofs: input });

      expect(h.mocks.send).toHaveBeenCalledWith(
        Amount.from(110),
        input,
        undefined,
        expect.objectContaining({
          send: { type: 'custom', data: expect.any(Array) },
          keep: { type: 'custom', data: expect.any(Array) },
        }),
      );
      expect(h.mocks.saveProofs).toHaveBeenCalledWith(
        f.mintUrl,
        expect.arrayContaining([
          expect.objectContaining({ secret: 'keep-1', state: 'ready' }),
          expect.objectContaining({ secret: 'send-1', state: 'inflight' }),
        ]),
      );
      expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['input-1'], 'inflight');
      expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['input-1'], 'spent');
      expect(h.hooks.executeMelt.mock.calls[0]?.[1]).toEqual([makeQuoteMeltProof('send-1', 60)]);
    });

    it('calculates swap fees from the proofs sent to melt', async () => {
      const result = await h.execute({
        operation: h.makeExecutingOperation({
          needsSwap: true,
          amount: Amount.from(55),
          inputAmount: Amount.from(200),
          inputProofSecrets: ['input-1'],
          swapOutputData: swapData(140, 60),
        }),
        proofs: [makeQuoteMeltCoreProof('input-1', 200)],
        response: { state: 'PAID', change: [] },
      });

      if (result.status !== 'PAID') throw new Error('Expected paid execution');
      expect(result.finalized.effectiveFee).toEqual(Amount.from(5));
    });

    it('requires prepared swap output data', async () => {
      await expect(
        h.execute({
          operation: h.makeExecutingOperation({
            needsSwap: true,
            inputProofSecrets: ['input-1'],
            swapOutputData: undefined,
          }),
          proofs: [makeQuoteMeltCoreProof('input-1', 200)],
        }),
      ).rejects.toThrow('Swap is required, but swap output data is missing');
    });

    it.each([
      ['returned', [makeQuoteMeltChange(10)], 0, true],
      ['empty', [], 10, false],
      ['undefined', undefined, 10, false],
    ] as const)('handles %s change signatures', async (_label, change, effectiveFee, unblinds) => {
      const result = await h.execute({
        operation: h.makeExecutingOperation({ inputProofSecrets: ['input-1'] }),
        proofs: [makeQuoteMeltCoreProof('input-1', 110)],
        response: { state: 'PAID', change: change ? [...change] : undefined },
      });

      if (result.status !== 'PAID') throw new Error('Expected paid execution');
      expect(result.finalized.effectiveFee).toEqual(Amount.from(effectiveFee));
      expect(h.mocks.unblindAndSaveChangeProofs).toHaveBeenCalledTimes(unblinds ? 1 : 0);
    });
  });

  describe('finalize', () => {
    it('uses complete persisted settlement data without checking the mint', async () => {
      const result = await h.finalize({
        operation: h.makePendingOperation({ inputProofSecrets: ['input-1'] }),
        quote: h.makeCanonicalQuote({
          state: 'PAID',
          change: [makeQuoteMeltChange(5)],
          payment_preimage: 'preimage-canonical',
        }),
      });

      expect(h.hooks.checkMeltQuote).not.toHaveBeenCalled();
      expect(result).toEqual({
        changeAmount: Amount.from(5),
        effectiveFee: Amount.from(5),
        finalizedData: { preimage: 'preimage-canonical' },
      });
    });

    it.each([
      ['missing', undefined],
      ['partial', 'canonical'],
    ] as const)('fetches %s settlement data', async (_label, canonical) => {
      const operation = h.makePendingOperation();
      const change = [makeQuoteMeltChange(5)];
      const result = await h.finalize({
        operation,
        quote: canonical ? h.makeCanonicalQuote({ state: 'PAID', change: undefined }) : undefined,
        response: {
          state: 'PAID',
          change,
          payment_preimage: 'preimage-remote',
        },
      });

      expect(h.hooks.checkMeltQuote).toHaveBeenCalledTimes(1);
      expect(h.mocks.unblindAndSaveChangeProofs).toHaveBeenCalledWith(
        f.mintUrl,
        deserializeOutputData(operation.changeOutputData).keep,
        change,
        { unit: 'sat', createdByOperationId: operation.id },
      );
      expect(result).toMatchObject({
        changeAmount: Amount.from(5),
        finalizedData: { preimage: 'preimage-remote' },
      });
    });

    it.each([
      ['canonical', true],
      ['remote', false],
    ])('rejects a non-paid %s quote', async (_label, canonical) => {
      const quote = canonical
        ? h.makeCanonicalQuote({ state: 'PENDING', change: undefined })
        : undefined;
      await expect(h.finalize({ quote, response: { state: 'PENDING' } })).rejects.toThrow(
        `Cannot finalize: melt quote ${f.quoteId} is PENDING, expected PAID`,
      );
      expect(h.hooks.checkMeltQuote).toHaveBeenCalledTimes(canonical ? 0 : 1);
    });

    it('spends swap send proofs and calculates fees from their amount', async () => {
      const result = await h.finalize({
        operation: h.makePendingOperation({
          needsSwap: true,
          amount: Amount.from(55),
          inputAmount: Amount.from(200),
          inputProofSecrets: ['input-1'],
          swapOutputData: swapData(140, 60),
        }),
        response: { state: 'PAID', change: [] },
      });

      expect(h.mocks.setProofState).toHaveBeenCalledWith(f.mintUrl, ['send-output'], 'spent');
      expect(result.effectiveFee).toEqual(Amount.from(5));
    });
  });

  describe('pending and rollback', () => {
    it.each([
      ['PAID', 'finalize'],
      ['PENDING', 'stay_pending'],
      ['UNPAID', 'rollback'],
    ] as const)('maps %s to %s', async (state, expected) => {
      await expect(h.checkPending(state)).resolves.toBe(expected);
    });

    it('uses a supplied canonical state and rejects unknown states', async () => {
      await expect(
        h.checkPending('PAID', h.makeCanonicalQuote({ state: 'PENDING' })),
      ).resolves.toBe('stay_pending');
      expect(h.hooks.checkMeltQuoteState).not.toHaveBeenCalled();
      await expect(h.checkPending('UNKNOWN')).rejects.toThrow('Unexpected melt quote state');
    });

    it('restores direct inputs on rollback', async () => {
      await h.rollback(h.makePreparedOperation());
      expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, ['input-1', 'input-2']);
    });

    it('restores swap sends and releases original inputs on rollback', async () => {
      await h.rollback(
        h.makePreparedOperation({
          needsSwap: true,
          inputProofSecrets: ['input-1'],
          swapOutputData: makeQuoteMeltOutputData([], [{ secret: 'send-1' }, { secret: 'send-2' }]),
        }),
      );
      expect(h.mocks.restoreProofsToReady).toHaveBeenCalledWith(f.mintUrl, ['send-1', 'send-2']);
      expect(h.mocks.releaseProofs).toHaveBeenCalledWith(f.mintUrl, ['input-1']);
    });
  });
});
