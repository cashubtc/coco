/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import type { RollingBackSendOperation } from 'coco-cashu-core';
import { SqliteRepositories } from '../index.ts';

function makeRollingBackOperation(): RollingBackSendOperation {
  return {
    id: 'send-op-1',
    mintUrl: 'https://mint.test',
    amount: 100,
    state: 'rolling_back',
    method: 'default',
    methodData: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    needsSwap: true,
    fee: 1,
    inputAmount: 101,
    inputProofSecrets: ['secret-1'],
  };
}

describe('SqliteSendOperationRepository', () => {
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

  it('loads rolling_back operations from repository read methods', async () => {
    const operation = makeRollingBackOperation();

    await repositories.sendOperationRepository.create(operation);

    expect(await repositories.sendOperationRepository.getById(operation.id)).toEqual(operation);
    expect(await repositories.sendOperationRepository.getByState('rolling_back')).toEqual([
      operation,
    ]);
    expect(await repositories.sendOperationRepository.getPending()).toEqual([operation]);
  });
});
