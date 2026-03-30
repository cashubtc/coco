/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import type { MeltOperation } from '@cashu/coco-core';
import { SqliteRepositories } from '../index.ts';

type FinalizedMeltOperation = Extract<MeltOperation, { state: 'finalized' }>;

function makeFinalizedMeltOperation(): FinalizedMeltOperation {
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

describe('SqliteMeltOperationRepository', () => {
  let database: Database;
  let repositories: SqliteRepositories;

  beforeEach(async () => {
    database = new Database(':memory:');
    repositories = new SqliteRepositories({ database });
    await repositories.init();
  });

  afterEach(async () => {
    await repositories.db.close();
  });

  it('round-trips settlement amounts for finalized operations', async () => {
    const operation = makeFinalizedMeltOperation();

    await repositories.meltOperationRepository.create(operation);

    expect(await repositories.meltOperationRepository.getById(operation.id)).toEqual(operation);
  });
});
