import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { RepositoryTransactionConflictError as AdapterConflictError } from '../../dist/adapter.js';
import { createSendOperation } from '../../operations/send/SendOperation.ts';
import { prepareSend } from '../../operations/send/SendTransitions.ts';
import type { Repositories } from '../../repositories/index.ts';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { applyRestoredKeyset } from '../../services/WalletRestoreTransitions.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keysetId = testMintKeysetId();
const proof = {
  id: keysetId,
  amount: Amount.from(16),
  secret: 'restored-input',
  C: testMintKeypairs['1'],
};
const restoreInput = {
  mintUrl,
  keysetId,
  unit: 'sat',
  lastCounterWithSignature: 29,
  observations: [{ proof, state: 'UNSPENT' as const }],
};
const sendInput = {
  operation: {
    ...createSendOperation(
      'send',
      mintUrl,
      { amount: Amount.from(8), unit: 'sat' },
      { method: 'default', methodData: {} },
    ),
    createdAt: 1000,
    updatedAt: 1000,
  },
  activeKeys: { id: keysetId, unit: 'sat', keys: testMintKeypairs },
  seed: new Uint8Array(32).fill(1),
  forceSwap: true,
};

function sourceRunner(repositories: Repositories) {
  // SQL adapters load the built package error class; this test runs source transitions.
  // Preserve the real conflict while aligning class identity for the source runner's retry policy.
  return new RepositoryCoreTransactionRunner(
    overrideTransactions(repositories, async (work) => {
      try {
        return await repositories.withTransaction(work);
      } catch (error) {
        if (error instanceof AdapterConflictError)
          throw new RepositoryTransactionConflictError(error.message, error);
        throw error;
      }
    }),
  );
}

describe.each(['memory', 'sqlite'] as const)('Restore transaction composition (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  let secondDatabase: Database | undefined;
  let directory: string | undefined;
  let secondRunner: RepositoryCoreTransactionRunner;
  let runner: RepositoryCoreTransactionRunner;

  beforeEach(async () => {
    if (adapter === 'sqlite') {
      directory = mkdtempSync(join(tmpdir(), 'coco-restore-'));
      database = new Database(join(directory, 'wallet.sqlite'));
      secondDatabase = new Database(join(directory, 'wallet.sqlite'));
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else repositories = new MemoryRepositories();
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
    runner = sourceRunner(repositories);
    secondRunner = secondDatabase
      ? sourceRunner(
          new SqlStorageRepositories({ database: new SqliteDb({ database: secondDatabase }) }),
        )
      : sourceRunner(repositories);
  });

  afterEach(() => {
    secondDatabase?.close();
    database?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it('composes Restore with Output Allocation and commits the consuming plan', async () => {
    const result = await runner.run(async (tx) => {
      await tx.perform(applyRestoredKeyset, restoreInput);
      return tx.perform(prepareSend, sendInput);
    });
    expect(result.counter?.counter).toBe(32);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(32);
    expect(await repositories.sendOperationRepository.getById('send')).toMatchObject({
      state: 'prepared',
      outputData: result.operation.outputData,
    });
    expect(
      await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret),
    ).toMatchObject({ usedByOperationId: 'send' });
    // A repeated, stale Restore cannot reclaim allocated positions or release this reservation.
    await runner.run((tx) => tx.perform(applyRestoredKeyset, restoreInput));
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(32);
    expect(
      await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret),
    ).toMatchObject({ usedByOperationId: 'send' });
    const next = await secondRunner.run(async (tx) => {
      await tx.perform(applyRestoredKeyset, {
        ...restoreInput,
        observations: [{ proof: { ...proof, secret: 'another-input' }, state: 'UNSPENT' }],
      });
      return tx.perform(prepareSend, {
        ...sendInput,
        operation: { ...sendInput.operation, id: 'next-send' },
      });
    });
    expect(next.counter?.counter).toBe(34);
    if (!result.operation.outputData || !next.operation.outputData) {
      throw new Error('Expected both committed output plans');
    }
    const committedOutputs = [
      ...result.operation.outputData.keep,
      ...result.operation.outputData.send,
      ...next.operation.outputData.keep,
      ...next.operation.outputData.send,
    ];
    expect(new Set(committedOutputs.map((output) => output.secret)).size).toBe(4);
  });

  it('rolls back Restore, allocation and reservation when the owning workflow fails', async () => {
    await expect(
      runner.run(async (tx) => {
        await tx.perform(applyRestoredKeyset, restoreInput);
        await tx.perform(prepareSend, sendInput);
        throw new Error('abort composition');
      }),
    ).rejects.toThrow('abort composition');
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret)).toBeNull();
    expect(await repositories.sendOperationRepository.getById('send')).toBeNull();
  });

  it('cannot commit an advanced counter when a Restore transition failure is caught', async () => {
    await repositories.proofRepository.saveProofs(mintUrl, [
      { ...proof, mintUrl, unit: 'sat', state: 'spent', C: 'different' },
    ]);
    await repositories.counterRepository.setCounter(mintUrl, keysetId, 4);
    await expect(
      runner.run(async (tx) => {
        try {
          await tx.perform(applyRestoredKeyset, restoreInput);
        } catch {
          /* caller cannot hide a failed transition */
        }
      }),
    ).rejects.toThrow('Conflicting proof');
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(4);
    expect(
      await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret),
    ).toMatchObject({ C: 'different', state: 'spent' });
  });

  it('serializes overlapping Restore and allocation without losing the committed maximum', async () => {
    await runner.run((tx) => tx.perform(applyRestoredKeyset, restoreInput));
    const [, allocation] = await Promise.all([
      runner.run((tx) =>
        tx.perform(applyRestoredKeyset, { ...restoreInput, lastCounterWithSignature: 99 }),
      ),
      secondRunner.run((tx) => tx.perform(prepareSend, sendInput)),
      runner.run((tx) => tx.perform(applyRestoredKeyset, restoreInput)),
    ]);
    expect(allocation.counter?.counter).toBe(102);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(102);
    expect(
      await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret),
    ).toMatchObject({ usedByOperationId: 'send' });
  });
});
