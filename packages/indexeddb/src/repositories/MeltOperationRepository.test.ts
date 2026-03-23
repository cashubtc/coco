/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import type { MeltOperation } from 'coco-cashu-core';
import { IdbMeltOperationRepository } from './MeltOperationRepository.ts';
import type { MeltOperationRow } from '../lib/db.ts';

type FinalizedMeltOperation = Extract<MeltOperation, { state: 'finalized' }>;

function makeFinalizedOperation(): FinalizedMeltOperation {
  return {
    id: 'melt-op-1',
    mintUrl: 'https://mint.test',
    state: 'finalized',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    createdAt: 1_000,
    updatedAt: 2_000,
    quoteId: 'quote-1',
    amount: 100,
    fee_reserve: 5,
    swap_fee: 0,
    needsSwap: false,
    inputAmount: 105,
    inputProofSecrets: ['secret-1'],
    changeOutputData: { keep: [], send: [] },
    changeAmount: 2,
    effectiveFee: 3,
    finalizedData: { preimage: '' },
  };
}

describe('IdbMeltOperationRepository', () => {
  it('loads finalized operations with settlement amounts', async () => {
    const row = {
      id: 'melt-op-1',
      mintUrl: 'https://mint.test',
      state: 'finalized',
      createdAt: 1,
      updatedAt: 2,
      error: null,
      method: 'bolt11',
      methodDataJson: JSON.stringify({ invoice: 'lnbc1test' }),
      quoteId: 'quote-1',
      amount: 100,
      fee_reserve: 5,
      swap_fee: 0,
      needsSwap: 0,
      inputAmount: 105,
      inputProofSecretsJson: JSON.stringify(['secret-1']),
      changeOutputDataJson: JSON.stringify({ keep: [], send: [] }),
      swapOutputDataJson: null,
      changeAmount: 2,
      effectiveFee: 3,
      finalizedDataJson: JSON.stringify({ preimage: '' }),
    } satisfies MeltOperationRow;

    const repository = new IdbMeltOperationRepository({
      table: () => ({
        get: async () => row,
      }),
    } as any);

    await expect(repository.getById('melt-op-1')).resolves.toEqual(makeFinalizedOperation());
  });

  it('persists settlement amounts for finalized operations', async () => {
    const operation = makeFinalizedOperation();
    let persistedRow: MeltOperationRow | undefined;

    const repository = new IdbMeltOperationRepository({
      runTransaction: async (
        _mode: 'r' | 'rw',
        _stores: string[],
        fn: (tx: { table: (name: string) => unknown }) => Promise<unknown>,
      ) =>
        fn({
          table: () => ({
            get: async () => undefined,
            where: () => ({
              equals: () => ({
                first: async () => undefined,
              }),
            }),
            add: async (row: MeltOperationRow) => {
              persistedRow = row;
            },
          }),
        }),
    } as any);

    await repository.create(operation);

    expect(persistedRow?.changeAmount).toBe(2);
    expect(persistedRow?.effectiveFee).toBe(3);
    expect(persistedRow?.finalizedDataJson).toBe(JSON.stringify({ preimage: '' }));
  });
});
