import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { recordUnownedProofsSpent } from '../../operations/proofs/ProofReconciliationTransitions.ts';
import type { CoreProof } from '../../types.ts';

const mintUrl = 'https://mint.test';
const proof: CoreProof = {
  mintUrl,
  id: 'keyset',
  unit: 'sat',
  amount: Amount.from(8),
  secret: 'unowned',
  C: 'signature',
  state: 'inflight',
};

describe.each(['memory', 'sqlite'] as const)('Proof reconciliation transitions (%s)', (adapter) => {
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

  it('marks only proofs that are still inflight and have no Owning Operation spent', async () => {
    const stored: CoreProof[] = [
      proof,
      { ...proof, secret: 'used', usedByOperationId: 'send' },
      { ...proof, secret: 'created', createdByOperationId: 'melt' },
      { ...proof, secret: 'ready', state: 'ready' },
      { ...proof, secret: 'pending', state: 'pending' },
    ];
    await repositories.proofRepository.saveProofs(mintUrl, stored);
    const runner = new RepositoryCoreTransactionRunner(repositories);

    const result = await runner.run((tx) =>
      tx.perform(recordUnownedProofsSpent, {
        mintUrl,
        secrets: [...stored.map((p) => p.secret), 'missing'],
      }),
    );

    expect(result.spentSecrets).toEqual(['unowned']);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, 'unowned')).toEqual({
      ...proof,
      state: 'spent',
    });
    for (const unchanged of stored.slice(1)) {
      expect(
        await repositories.proofRepository.getProofBySecret(mintUrl, unchanged.secret),
      ).toEqual(unchanged);
    }
  });

  it('reports no change when the proof was already reconciled', async () => {
    await repositories.proofRepository.saveProofs(mintUrl, [{ ...proof, state: 'spent' }]);
    const runner = new RepositoryCoreTransactionRunner(repositories);

    const result = await runner.run((tx) =>
      tx.perform(recordUnownedProofsSpent, { mintUrl, secrets: [proof.secret] }),
    );

    expect(result.spentSecrets).toEqual([]);
  });
});
