import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { createSendOperation } from '../../operations/send/SendOperation.ts';
import type { Repositories } from '../../repositories/index.ts';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransaction,
} from '../../transactions/CoreTransaction.ts';
import {
  beginSendExecution,
  prepareSend,
} from '../../transactions/transitions/send/SendTransitions.ts';
import type { PrepareSendInput } from '../../transactions/transitions/send/SendTransitionTypes.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();

function input(id = 'composed-send'): PrepareSendInput {
  return {
    operation: {
      ...createSendOperation(
        id,
        mintUrl,
        { amount: Amount.from(8), unit: 'sat' },
        { method: 'default', methodData: {} },
      ),
      createdAt: 1000,
      updatedAt: 2000,
    },
    activeKeys: { id: keysetId, unit: 'sat', keys: testMintKeypairs },
    seed: new Uint8Array(32).fill(1),
    forceSwap: true,
  };
}

describe.each(['memory', 'sqlite'] as const)('Send transaction composition (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  let runner: RepositoryCoreTransactionRunner;
  let opens: number;

  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else {
      repositories = new MemoryRepositories();
    }
    await repositories.init();
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Test',
      trusted: true,
      mintInfo: testMintInfo,
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
    await repositories.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(16),
        secret: 'composed-input',
        C: testMintKeypairs['1'],
        mintUrl,
        unit: 'sat',
        state: 'ready',
      },
    ]);
    opens = 0;
    runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) => {
        opens++;
        return repositories.withTransaction(work);
      }),
    );
  });

  afterEach(() => database?.close());

  async function expectRolledBack() {
    expect(await repositories.sendOperationRepository.getById('composed-send')).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
    const proof = await repositories.proofRepository.getProofBySecret(mintUrl, 'composed-input');
    expect(proof?.state).toBe('ready');
    expect(proof?.usedByOperationId == null).toBe(true);
  }

  it('composes key allocation, Send preparation, and execution authorization in one commit', async () => {
    const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const sendInput = input();
    const executionInput = { operationId: sendInput.operation.id, updatedAt: 3000 };

    const result = await runner.run(async (tx) => {
      const key = await tx.keypairs.allocate(keyInput);
      const prepared = await prepareSend(tx, sendInput);
      const begun = await beginSendExecution(tx, executionInput);
      return { key, prepared, begun };
    });

    expect(opens).toBe(1);
    expect(result.key.derivationIndex).toBe(0);
    expect(result.begun.request.outputData).toEqual(result.prepared.operation.outputData!);
    expect(await repositories.sendOperationRepository.getById('composed-send')).toMatchObject({
      state: 'executing',
      revision: 1,
      updatedAt: 3000,
    });
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(2);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(0);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'composed-input'))
        ?.usedByOperationId,
    ).toBe('composed-send');
  });

  it('rolls back all domains when a later transaction function rejects', async () => {
    const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const sendInput = input();
    await expect(
      runner.run(async (tx) => {
        await tx.keypairs.allocate(keyInput);
        await prepareSend(tx, sendInput);
        await beginSendExecution(tx, { operationId: 'missing', updatedAt: 3000 });
      }),
    ).rejects.toThrow('Send operation not found');

    expect(opens).toBe(1);
    await expectRolledBack();
  });

  it('cannot commit earlier work by catching a transaction function validation failure', async () => {
    const sendInput = input();
    let rejectedFurtherWork = false;
    await expect(
      runner.run(async (tx) => {
        await prepareSend(tx, sendInput);
        // The duplicate is rejected by the function itself, after a successful repository read.
        await prepareSend(tx, sendInput).catch(() => {});
        await tx.sendOperations.getById(sendInput.operation.id).catch(() => {
          rejectedFurtherWork = true;
        });
      }),
    ).rejects.toThrow('already exists');

    expect(rejectedFurtherWork).toBe(true);
    await expectRolledBack();
  });

  it('drains a dropped transaction function through its final operation write before committing', async () => {
    const sendInput = input();
    await runner.run(async (tx) => {
      void prepareSend(tx, sendInput);
    });

    expect(opens).toBe(1);
    expect((await repositories.sendOperationRepository.getById('composed-send'))?.state).toBe(
      'prepared',
    );
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(2);
  });

  it.each(['commit', 'rollback'] as const)(
    'rejects reuse of a transaction function after %s',
    async (completion) => {
      let captured!: CoreTransaction;
      let readOperation!: CoreTransaction['sendOperations']['getById'];
      const sendInput = input();
      const work = runner.run(async (tx) => {
        captured = tx;
        readOperation = tx.sendOperations.getById;
        await prepareSend(tx, sendInput);
        if (completion === 'rollback') throw new Error('abort composition');
      });
      if (completion === 'rollback') await expect(work).rejects.toThrow('abort composition');
      else await work;

      await expect(prepareSend(captured, input('late-send'))).rejects.toThrow('scope is closed');
      await expect(readOperation(sendInput.operation.id)).rejects.toThrow('scope is closed');
      expect(await repositories.sendOperationRepository.getById('late-send')).toBeNull();
      expect(opens).toBe(1);
    },
  );

  it('retries the entire composition with fresh scopes and unchanged request inputs', async () => {
    const keyInput = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const sendInput = input();
    const executionInput = { operationId: sendInput.operation.id, updatedAt: 3000 };
    const scopes: CoreTransaction[] = [];
    const allocations: unknown[] = [];
    let attempts = 0;
    const retrying = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) =>
        repositories.withTransaction(async (scope) => {
          const result = await work(scope);
          if (++attempts < 3) throw new RepositoryTransactionConflictError('retry composition');
          return result;
        }),
      ),
    );

    await retrying.run(async (tx) => {
      scopes.push(tx);
      const key = await tx.keypairs.allocate(keyInput);
      const prepared = await prepareSend(tx, sendInput);
      const begun = await beginSendExecution(tx, executionInput);
      allocations.push({ key, outputData: prepared.operation.outputData, request: begun.request });
    });

    expect(attempts).toBe(3);
    expect(new Set(scopes).size).toBe(3);
    expect(allocations[0]).toEqual(allocations[1]);
    expect(allocations[1]).toEqual(allocations[2]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(0);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(2);
    expect(await repositories.sendOperationRepository.getById('composed-send')).toMatchObject({
      createdAt: 1000,
      updatedAt: 3000,
      state: 'executing',
      revision: 1,
    });
    await expect(prepareSend(scopes[0]!, input('expired-retry'))).rejects.toThrow(
      'scope is closed',
    );
  });
});
