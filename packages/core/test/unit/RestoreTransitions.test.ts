import { testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { Database } from 'bun:sqlite';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import type { Repositories } from '../../repositories/index.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { Amount } from '@cashu/cashu-ts';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { applyRestoreResult } from '../../operations/restore/RestoreTransitions.ts';
import type { CoreProof } from '../../types.ts';

const mintUrl = 'https://mint.test';
const keysetId = 'old-keyset';
const proof: CoreProof = {
  mintUrl,
  id: keysetId,
  unit: 'sat',
  amount: Amount.from(8),
  secret: 'restored',
  C: 'signature',
  state: 'ready',
};

describe.each(['memory', 'sqlite'] as const)('Restore transactions (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else repositories = new MemoryRepositories();
    await repositories.init();
  });
  afterEach(() => database?.close());
  it('adds discovered proofs without rewinding the durable high-water mark', async () => {
    await repositories.counterRepository.setCounter(mintUrl, keysetId, 30);
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const result = await runner.run((tx) =>
      tx.perform(applyRestoreResult, {
        mintUrl,
        keysetId,
        proofs: [proof],
        nextCounter: 11,
      }),
    );
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toEqual({
      mintUrl,
      keysetId,
      counter: 30,
    });
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret)).toEqual(
      proof,
    );
    expect(result.inserted).toEqual([proof]);
    expect(result.counter).toBeUndefined();
  });
  it('rolls back proof inserts when advancing the counter fails', async () => {
    const failing = overrideTransactions(repositories, (work) =>
      repositories.withTransaction((scope) =>
        work({
          ...scope,
          counterRepository: {
            ...scope.counterRepository,
            getCounter: scope.counterRepository.getCounter.bind(scope.counterRepository),
            setCounter: async () => {
              throw new Error('counter write failed');
            },
          },
        }),
      ),
    );
    const runner = new RepositoryCoreTransactionRunner(failing);
    await expect(
      runner.run((tx) =>
        tx.perform(applyRestoreResult, {
          mintUrl,
          keysetId,
          proofs: [proof],
          nextCounter: 1,
        }),
      ),
    ).rejects.toThrow('counter write failed');
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret)).toBeNull();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });
  it('reconciles only unowned pending proofs and is idempotent on repeat scans', async () => {
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const owned = {
      ...proof,
      secret: 'owned',
      state: 'inflight' as const,
      usedByOperationId: 'send',
      createdByOperationId: 'mint',
    };
    await repositories.proofRepository.saveProofs(mintUrl, [owned]);
    const scan = {
      mintUrl,
      keysetId,
      nextCounter: 1,
      proofs: [
        { ...proof, state: 'pending' as const },
        { ...proof, secret: 'owned', state: 'ready' as const },
        { ...proof, secret: 'spent', state: 'spent' as const },
      ],
    };
    const restored = await runner.run((tx) => tx.perform(applyRestoreResult, scan));
    expect(restored.inserted.map((p) => p.state)).toEqual(['pending']);
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'owned')).toEqual(owned);
    const repeated = await runner.run((tx) => tx.perform(applyRestoreResult, scan));
    expect(repeated).toEqual({ inserted: [], updated: [], counter: undefined });
    const resolved = await runner.run((tx) =>
      tx.perform(applyRestoreResult, { ...scan, proofs: [proof] }),
    );
    expect(resolved.updated.map((p) => p.state)).toEqual(['ready']);
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([proof]);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'spent')).toBeNull();
  });
  it('preserves allocation made concurrently with applying an older scan', async () => {
    const activeId = testMintKeysetId();
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: activeId,
      unit: 'sat',
      active: true,
      keypairs: testMintKeypairs,
      feePpk: 0,
    });
    await repositories.counterRepository.setCounter(mintUrl, activeId, 30);
    const allocator = new RepositoryCoreTransactionRunner(repositories);
    const restore = new RepositoryCoreTransactionRunner(repositories);
    await Promise.all([
      allocator.run((tx) =>
        tx.outputs.allocate({
          mintUrl,
          unit: 'sat',
          activeKeys: { id: activeId, unit: 'sat', keys: testMintKeypairs },
          seed: new Uint8Array(32).fill(1),
          keepAmount: Amount.from(8),
          sendAmount: Amount.zero(),
        }),
      ),
      restore.run((tx) =>
        tx.perform(applyRestoreResult, {
          mintUrl,
          keysetId: activeId,
          proofs: [{ ...proof, id: activeId }],
          nextCounter: 11,
        }),
      ),
    ]);
    expect((await repositories.counterRepository.getCounter(mintUrl, activeId))?.counter).toBe(31);
  });

  it('rolls back pending reconciliation and counter advancement on conflicting immutable data', async () => {
    await repositories.proofRepository.saveProofs(mintUrl, [
      { ...proof, state: 'pending' },
      { ...proof, secret: 'conflict', createdByOperationId: 'creator' },
    ]);
    const runner = new RepositoryCoreTransactionRunner(repositories);
    await expect(
      runner.run((tx) =>
        tx.perform(applyRestoreResult, {
          mintUrl,
          keysetId,
          nextCounter: 10,
          proofs: [proof, { ...proof, secret: 'conflict', amount: Amount.from(16) }],
        }),
      ),
    ).rejects.toThrow('Conflicting proof');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret))?.state,
    ).toBe('pending');
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid counter %s atomically',
    async (nextCounter) => {
      const runner = new RepositoryCoreTransactionRunner(repositories);
      await expect(
        runner.run((tx) =>
          tx.perform(applyRestoreResult, { mintUrl, keysetId, nextCounter, proofs: [proof] }),
        ),
      ).rejects.toThrow('Invalid restored output counter');
      expect(await repositories.proofRepository.getProofBySecret(mintUrl, proof.secret)).toBeNull();
    },
  );
});
