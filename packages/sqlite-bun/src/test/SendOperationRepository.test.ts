/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import type { PendingSendOperation, RollingBackSendOperation } from 'coco-cashu-core';
import { getStorageRepositories } from 'coco-cashu-core/adapter';
import { SqliteStorage } from '../index.ts';

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

function makePendingP2pkOperation(): PendingSendOperation {
  return {
    id: 'send-op-p2pk',
    mintUrl: 'https://mint.test',
    amount: 100,
    state: 'pending',
    method: 'p2pk',
    methodData: { pubkey: '02' + '11'.repeat(32) },
    createdAt: 1_000,
    updatedAt: 2_000,
    needsSwap: true,
    fee: 1,
    inputAmount: 101,
    inputProofSecrets: ['secret-1'],
    outputData: {
      keep: [],
      send: [],
    },
    token: {
      mint: 'https://mint.test',
      proofs: [{ id: 'keyset-1', amount: 100, secret: 'send-secret', C: 'C_send' }],
      unit: 'sat',
    },
  } as PendingSendOperation;
}

describe('SqliteSendOperationRepository', () => {
  let database: Database;
  let repositories: SqliteStorage;

  beforeEach(async () => {
    database = new Database(':memory:');
    repositories = new SqliteStorage({ database });
    await repositories.init();
  });

  afterEach(async () => {
    await repositories.db.close();
  });

  it('loads rolling_back operations from repository read methods', async () => {
    const operation = makeRollingBackOperation();
    const repoSet = getStorageRepositories(repositories);

    await repoSet.sendOperationRepository.create(operation);

    expect(await repoSet.sendOperationRepository.getById(operation.id)).toEqual(operation);
    expect(await repoSet.sendOperationRepository.getByState('rolling_back')).toEqual([
      operation,
    ]);
    expect(await repoSet.sendOperationRepository.getPending()).toEqual([operation]);
  });

  it('round-trips persisted tokens for pending P2PK operations', async () => {
    const operation = makePendingP2pkOperation();
    const repoSet = getStorageRepositories(repositories);

    await repoSet.sendOperationRepository.create(operation);

    expect(await repoSet.sendOperationRepository.getById(operation.id)).toEqual(operation);
  });
});
