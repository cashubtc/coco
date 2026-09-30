import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { prepareSend } from '../../operations/send/SendTransitions.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { testMintInfo } from '../fixtures/MintMetadata.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { createSendOperation } from '../../operations/send/SendOperation.ts';
import { preparedSend, pendingSend } from '../fixtures/SendOperation.ts';
import type { PrepareSendInput } from '../../operations/send/SendTransitionTypes.ts';
import {
  SendOperationConflictError,
  SendOperationIntentConflictError,
} from '../../models/Error.ts';

const mintUrl = 'https://mint.test';
const keysetId = 'keyset-1';
const keys = { id: keysetId, unit: 'sat', keys: { 1: 'unused' } };

function proof(secret: string, amount = 10, id = keysetId) {
  return {
    id,
    secret,
    amount: Amount.from(amount),
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready' as const,
  };
}

function operation(id: string, forceSwap = true) {
  return {
    ...createSendOperation(
      id,
      mintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      {
        method: 'default' as const,
        methodData: forceSwap ? { forceSwap: true } : {},
      },
    ),
    createdAt: 100,
    updatedAt: 200,
  };
}

async function setup() {
  const repositories = new MemoryRepositories();
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
    keypairs: { 1: 'unused' },
    active: true,
    feePpk: 0,
  });
  const runner = new RepositoryCoreTransactionRunner(repositories);
  return { repositories, transactionRunner: runner };
}

function prepareInput(id: string, forceSwap = false): PrepareSendInput {
  return {
    operation: operation(id, forceSwap),
    activeKeys: keys,
    seed: new Uint8Array(32).fill(1),
    forceSwap,
    joinable: id.startsWith('send:'),
  };
}

describe('Send transitions create-or-join', () => {
  it('returns outcome created for a new namespaced ID', async () => {
    const { repositories, transactionRunner } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);

    const result = await transactionRunner.run((tx) =>
      tx.perform(prepareSend, prepareInput('send:new-op', false)),
    );

    expect(result.outcome).toBe('created');
    expect(result.reservation).not.toBeNull();
    expect(result.reservation?.secrets).toEqual(['proof-1']);
    expect(result.operation.state).toBe('prepared');
  });

  it('joins an existing prepared operation with the same intent', async () => {
    const { repositories, transactionRunner } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const id = 'send:reused-op';

    await transactionRunner.run((tx) => tx.perform(prepareSend, prepareInput(id, false)));
    const before = await repositories.proofRepository.getAvailableProofs(mintUrl, { unit: 'sat' });

    const joined = await transactionRunner.run((tx) =>
      tx.perform(prepareSend, prepareInput(id, false)),
    );

    expect(joined.outcome).toBe('joined');
    expect(joined.reservation).toBeNull();
    expect(joined.operation.state).toBe('prepared');
    expect(await repositories.sendOperationRepository.getByState('prepared')).toHaveLength(1);
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl, { unit: 'sat' })).toEqual(
      before,
    );
  });

  it('join returns the existing operation without selecting new proofs', async () => {
    const { repositories, transactionRunner } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1'), proof('proof-2')]);
    const id = 'send:reused-op';

    const first = await transactionRunner.run((tx) =>
      tx.perform(prepareSend, prepareInput(id, true)),
    );
    const joined = await transactionRunner.run((tx) =>
      tx.perform(prepareSend, prepareInput(id, true)),
    );

    expect(joined.outcome).toBe('joined');
    expect(joined.operation.inputProofSecrets).toEqual(first.operation.inputProofSecrets);
  });

  it('throws SendOperationIntentConflictError when the intent differs', async () => {
    const { repositories, transactionRunner } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [
      proof('proof-1', 10),
      proof('proof-2', 20),
    ]);
    const id = 'send:op';

    await transactionRunner.run((tx) =>
      tx.perform(prepareSend, {
        ...prepareInput(id, false),
        operation: { ...operation(id, false), amount: Amount.from(10) },
      }),
    );

    const conflict = await transactionRunner
      .run((tx) =>
        tx.perform(prepareSend, {
          ...prepareInput(id, false),
          operation: { ...operation(id, false), amount: Amount.from(20) },
        }),
      )
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SendOperationIntentConflictError);
    expect((conflict as SendOperationIntentConflictError).operationId).toBe(id);
    expect(await repositories.sendOperationRepository.getByState('prepared')).toHaveLength(1);
  });

  it('throws SendOperationConflictError when the existing operation is past prepared', async () => {
    const { repositories, transactionRunner } = await setup();
    const id = 'send:op';
    await repositories.sendOperationRepository.create(pendingSend(id, [proof('input', 10)]));

    const conflict = await transactionRunner
      .run((tx) => tx.perform(prepareSend, prepareInput(id, false)))
      .catch((error: unknown) => error);

    expect(conflict).toBeInstanceOf(SendOperationConflictError);
    expect(conflict).not.toBeInstanceOf(SendOperationIntentConflictError);
    expect((conflict as Error).message).toContain("state 'pending'");
  });

  it('throws SendOperationConflictError for a generated-ID duplicate', async () => {
    const { repositories, transactionRunner } = await setup();
    const id = 'generated-id';
    const input = proof('proof-1');
    await repositories.proofRepository.saveProofs(mintUrl, [input]);
    await repositories.sendOperationRepository.create(preparedSend(id, [input]));

    await expect(
      transactionRunner.run((tx) =>
        tx.perform(prepareSend, {
          ...prepareInput(id, false),
          operation: createSendOperation(
            id,
            mintUrl,
            { amount: Amount.from(10), unit: 'sat' },
            { method: 'default', methodData: {} },
          ),
        }),
      ),
    ).rejects.toBeInstanceOf(SendOperationConflictError);
  });
});
