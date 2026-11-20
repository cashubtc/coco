import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import type { PreparedMeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { PendingMintOperation } from '../../operations/mint/MintOperation.ts';
import { projectMintSwapHistoryEntry } from '../../repositories/MintSwapHistoryProjection.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';

describe('Mint Swap history projection', () => {
  it('projects every parent state with explicit current or last-safe provenance', () => {
    const fixtures = mintSwapFixtures();

    for (const parent of Object.values(fixtures)) {
      const entry = projectMintSwapHistoryEntry(parent, null, null);
      expect(entry.id).toBe(`mint-swap:${parent.id}`);
      expect(entry.state).toBe(parent.state);
      expect(entry.progress.provenance).toBe(
        parent.state === 'cancelled' ||
          parent.state === 'failed' ||
          parent.state === 'needs_attention'
          ? 'last_safe'
          : 'current',
      );
      const expectedProgressState =
        parent.state === 'cancelled' ||
        parent.state === 'failed' ||
        parent.state === 'needs_attention'
          ? parent.lastSafe.state
          : parent.state;
      expect(entry.progress.state).toBe(expectedProgressState);
      expect(entry.sourceChild).toEqual({ operationId: parent.sourceOperationId, present: false });
      expect(entry.destinationChild).toEqual({
        operationId: parent.destinationOperationId,
        present: false,
      });
    }
  });

  it('uses destination aliases and child freshness without moving parent authority', () => {
    const parent = mintSwapFixtures().needs_attention;
    const source = makeSourceChild(parent.sourceOperationId, parent.updatedAt + 1_000);
    const destination = makeDestinationChild(
      parent.destinationOperationId,
      parent.updatedAt + 2_000,
    );

    const entry = projectMintSwapHistoryEntry(parent, source, destination);

    expect(entry).toMatchObject({
      type: 'mint-swap',
      state: 'needs_attention',
      mintUrl: parent.destinationMintUrl,
      sourceMintUrl: parent.sourceMintUrl,
      destinationMintUrl: parent.destinationMintUrl,
      unit: 'sat',
      parentUpdatedAt: parent.updatedAt,
      parentRevision: parent.revision,
      updatedAt: destination.updatedAt,
      sourceChild: {
        operationId: source.id,
        present: true,
        state: source.state,
        updatedAt: source.updatedAt,
      },
      destinationChild: {
        operationId: destination.id,
        present: true,
        state: destination.state,
        updatedAt: destination.updatedAt,
      },
    });
    expect(entry.amount).toEqual(parent.destinationAmount);
    expect(entry.destinationAmount).toEqual(parent.destinationAmount);
    expect(entry.progress).toEqual({ provenance: 'last_safe', ...parent.lastSafe });
  });

  it('keeps protocol and recovery material outside the public row', () => {
    const parent = mintSwapFixtures().destination_pending;
    const entry = projectMintSwapHistoryEntry(parent, null, null);

    for (const forbidden of [
      'sourceQuote',
      'destinationQuote',
      'paymentRequestHash',
      'retry',
      'outputData',
      'proofs',
      'token',
      'error',
    ]) {
      expect(forbidden in entry).toBe(false);
    }
  });

  it('rejects a child that does not match the immutable parent link', () => {
    const parent = mintSwapFixtures().prepared;
    expect(() => projectMintSwapHistoryEntry(parent, makeSourceChild('wrong', 1), null)).toThrow(
      'source child mismatch',
    );
    expect(() =>
      projectMintSwapHistoryEntry(parent, null, makeDestinationChild('wrong', 1)),
    ).toThrow('destination child mismatch');
  });
});

function makeSourceChild(id: string, updatedAt: number): PreparedMeltOperation {
  return {
    id,
    state: 'prepared',
    mintUrl: 'https://source.example',
    method: 'bolt11',
    methodData: { invoice: 'lnbc-source' },
    unit: 'sat',
    amount: Amount.from(100),
    needsSwap: false,
    fee_reserve: Amount.from(1),
    quoteId: 'source-quote',
    swap_fee: Amount.zero(),
    inputAmount: Amount.from(101),
    inputProofSecrets: ['source-secret'],
    changeOutputData: { keep: [], send: [] },
    createdAt: updatedAt - 1,
    updatedAt,
  };
}

function makeDestinationChild(id: string, updatedAt: number): PendingMintOperation {
  return {
    id,
    state: 'pending',
    mintUrl: 'https://destination.example',
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(100),
    unit: 'sat',
    quoteId: 'destination-quote',
    request: 'lnbc-destination',
    expiry: null,
    outputData: { keep: [], send: [] },
    createdAt: updatedAt - 1,
    updatedAt,
  };
}
