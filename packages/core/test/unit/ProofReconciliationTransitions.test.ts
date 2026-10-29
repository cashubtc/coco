import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { createMeltOperation } from '../../operations/melt/MeltOperation.ts';
import { recordUnownedProofsSpent } from '../../operations/proofs/ProofReconciliationTransitions.ts';
import { createSendOperation, type SendOperation } from '../../operations/send/SendOperation.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
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

const liveSend = (id: string) =>
  createSendOperation(
    id,
    mintUrl,
    { amount: Amount.from(8), unit: 'sat' },
    {
      method: 'default',
      methodData: {},
    },
  );

const finalizedSend = (id: string): SendOperation => ({
  ...liveSend(id),
  state: 'finalized',
  needsSwap: false,
  fee: Amount.zero(),
  inputAmount: Amount.from(8),
  inputProofSecrets: [],
});

const liveMelt = (id: string) =>
  createMeltOperation(id, mintUrl, { method: 'bolt11', methodData: { invoice: 'invoice' } });

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
    await repositories.sendOperationRepository.create(liveSend('send'));
    await repositories.meltOperationRepository.create(liveMelt('melt'));
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

  it('marks inflight proofs whose referenced operations are missing or terminal spent', async () => {
    await repositories.sendOperationRepository.create(finalizedSend('finalized-send'));
    await repositories.sendOperationRepository.create(liveSend('live-send'));
    const dead: CoreProof[] = [
      { ...proof, secret: 'deleted-owner', usedByOperationId: 'deleted' },
      { ...proof, secret: 'terminal-owner', createdByOperationId: 'finalized-send' },
      {
        ...proof,
        secret: 'both-dead',
        usedByOperationId: 'deleted',
        createdByOperationId: 'finalized-send',
      },
    ];
    const live: CoreProof = {
      ...proof,
      secret: 'live-creator',
      usedByOperationId: 'deleted',
      createdByOperationId: 'live-send',
    };
    await repositories.proofRepository.saveProofs(mintUrl, [...dead, live]);
    const runner = new RepositoryCoreTransactionRunner(repositories);

    const result = await runner.run((tx) =>
      tx.perform(recordUnownedProofsSpent, {
        mintUrl,
        secrets: [...dead, live].map((p) => p.secret),
      }),
    );

    expect(result.spentSecrets.sort()).toEqual(dead.map((p) => p.secret).sort());
    for (const reconciled of dead) {
      expect(
        (await repositories.proofRepository.getProofBySecret(mintUrl, reconciled.secret))?.state,
      ).toBe('spent');
    }
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, live.secret)).toEqual(live);
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
