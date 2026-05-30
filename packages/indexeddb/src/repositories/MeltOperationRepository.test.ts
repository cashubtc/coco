/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { Amount, type MeltOperation } from '@cashu/coco-core';
import { IdbMeltOperationRepository } from './MeltOperationRepository.ts';
import type { MeltOperationRow } from '../lib/db.ts';

type FinalizedMeltOperation = Extract<MeltOperation, { state: 'finalized' }>;

function makeFinalizedOperation(
  overrides: Partial<FinalizedMeltOperation> = {},
): FinalizedMeltOperation {
  return {
    id: 'melt-op-1',
    mintUrl: 'https://mint.test',
    state: 'finalized',
    method: 'bolt11',
    methodData: { invoice: 'lnbc1test' },
    createdAt: 1_000,
    updatedAt: 2_000,
    quoteId: 'quote-1',
    unit: 'sat',
    amount: Amount.from(100),
    fee_reserve: Amount.from(5),
    swap_fee: Amount.zero(),
    needsSwap: false,
    inputAmount: Amount.from(105),
    inputProofSecrets: ['secret-1'],
    changeOutputData: { keep: [], send: [] },
    changeAmount: Amount.from(2),
    effectiveFee: Amount.from(3),
    finalizedData: { preimage: '' },
    ...overrides,
  };
}

function makeRepositoryWithRows(rows: MeltOperationRow[]): IdbMeltOperationRepository {
  return new IdbMeltOperationRepository({
    runTransaction: async (
      _mode: 'r' | 'rw',
      _stores: string[],
      fn: (tx: { table: (name: string) => unknown }) => Promise<unknown>,
    ) =>
      fn({
        table: () => ({
          get: async (id: string) => rows.find((row) => row.id === id),
          where: () => ({
            equals: ([mintUrl, quoteId]: [string, string]) => ({
              first: async () =>
                rows.find((row) => row.mintUrl === mintUrl && row.quoteId === quoteId),
            }),
          }),
          add: async (row: MeltOperationRow) => {
            rows.push(row);
          },
          put: async (row: MeltOperationRow) => {
            const index = rows.findIndex((existing) => existing.id === row.id);
            if (index >= 0) {
              rows[index] = row;
            } else {
              rows.push(row);
            }
          },
        }),
      }),
  } as any);
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
      unit: 'sat',
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

  it('defaults legacy finalized rows without unit to sat', async () => {
    const row = {
      id: 'melt-op-legacy',
      mintUrl: 'https://mint.test',
      state: 'finalized',
      createdAt: 1,
      updatedAt: 2,
      error: null,
      method: 'bolt11',
      methodDataJson: JSON.stringify({ invoice: 'lnbc1test' }),
      quoteId: 'quote-legacy',
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

    await expect(repository.getById('melt-op-legacy')).resolves.toMatchObject({
      unit: 'sat',
    });
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

    expect(persistedRow?.changeAmount).toBe('2');
    expect(persistedRow?.effectiveFee).toBe('3');
    expect(persistedRow?.finalizedDataJson).toBe(JSON.stringify({ preimage: '' }));
  });

  it('rejects duplicate quote-bound operations on create', async () => {
    const rows: MeltOperationRow[] = [];
    const repository = makeRepositoryWithRows(rows);
    await repository.create(makeFinalizedOperation());

    await expect(repository.create(makeFinalizedOperation({ id: 'melt-op-2' }))).rejects.toThrow(
      'MeltOperation already exists',
    );
  });

  it('rejects updates that would duplicate a quote binding', async () => {
    const rows: MeltOperationRow[] = [];
    const repository = makeRepositoryWithRows(rows);
    await repository.create(makeFinalizedOperation());
    await repository.create(
      makeFinalizedOperation({ id: 'melt-op-2', quoteId: 'other-melt-quote' }),
    );

    await expect(repository.update(makeFinalizedOperation({ id: 'melt-op-2' }))).rejects.toThrow(
      'MeltOperation already exists',
    );
  });
});
