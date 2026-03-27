import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import type { PendingSendOperation, RollingBackSendOperation } from 'coco-cashu-core';
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
  let database: BetterSqlite3Database;
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

    await expect(repositories.sendOperationRepository.getById(operation.id)).resolves.toEqual(
      operation,
    );
    await expect(repositories.sendOperationRepository.getByState('rolling_back')).resolves.toEqual([
      operation,
    ]);
    await expect(repositories.sendOperationRepository.getPending()).resolves.toEqual([operation]);
  });

  it('round-trips persisted tokens for pending P2PK operations', async () => {
    const operation = makePendingP2pkOperation();

    await repositories.sendOperationRepository.create(operation);

    await expect(repositories.sendOperationRepository.getById(operation.id)).resolves.toEqual(
      operation,
    );
  });
});
