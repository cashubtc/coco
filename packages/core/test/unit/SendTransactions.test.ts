import { Amount, type MintKeys, type OutputDataLike } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { createSendOperation, type PreparedSendOperation } from '../../operations/send';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  createCoreTransactionModuleFactory,
} from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { PrepareSendCommand } from '../../transactions/send/TransactionalSendOperations.ts';
import type { CoreProof } from '../../types.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

const mintUrl = 'https://mint.test';
const keysetId = 'keyset-1';
const keys = { id: keysetId, unit: 'sat', keys: { 1: 'unused' } } as MintKeys;

function proof(secret: string, amount = 10): CoreProof {
  return {
    id: keysetId,
    secret,
    amount: Amount.from(amount),
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
  };
}

function operation(id: string, forceSwap = true) {
  return {
    ...createSendOperation(
      id,
      mintUrl,
      { amount: Amount.from(10), unit: 'sat' },
      {
        method: 'default',
        methodData: forceSwap ? { forceSwap: true } : {},
      },
    ),
    createdAt: 100,
    updatedAt: 200,
  };
}

function output(amount: Amount, counter: number): OutputDataLike {
  return {
    blindedMessage: { amount, id: keysetId, B_: `B-${counter}` },
    blindingFactor: BigInt(counter + 1),
    secret: new Uint8Array([counter + 1]),
    toProof: () => {
      throw new Error('not used');
    },
  };
}

async function setup() {
  const repositories = new MemoryRepositories();
  await repositories.keysetRepository.addKeyset({
    mintUrl,
    id: keysetId,
    unit: 'sat',
    keypairs: { 1: 'unused' },
    active: true,
    feePpk: 0,
  });
  const outputDataCreator = makeOutputDataCreator({
    createDeterministicData: (amount, _seed, counter) => [output(Amount.from(amount), counter)],
  });
  const runner = new RepositoryCoreTransactionRunner(
    repositories,
    createCoreTransactionModuleFactory(outputDataCreator),
  );
  return { repositories, transactions: new CoreSendTransactions(runner) };
}

function command(id: string, forceSwap = true): PrepareSendCommand {
  return {
    operation: operation(id, forceSwap),
    activeKeys: keys,
    seed: new Uint8Array(32).fill(1),
  };
}

describe('SendTransactions preparation', () => {
  it('reserves proofs, allocates outputs, advances the counter, and creates prepared atomically', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);

    const result = await transactions.prepare(command('send-1'));

    expect(result.operation.state).toBe('prepared');
    expect(result.operation.revision).toBe(0);
    expect(result.operation.inputProofSecrets).toEqual(['proof-1']);
    expect(result.operation.outputData?.send[0]?.blindedMessage.B_).toBe('B-0');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBe('send-1');
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
    expect((await repositories.sendOperationRepository.getById('send-1'))?.state).toBe('prepared');
    expect(await repositories.sendOperationRepository.getByState('init')).toEqual([]);
  });

  it('rolls back reservation and counter allocation when final operation persistence conflicts', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    await repositories.counterRepository.setCounter(mintUrl, keysetId, 5);
    const existing: PreparedSendOperation = {
      ...operation('send-conflict'),
      state: 'prepared',
      needsSwap: false,
      fee: Amount.zero(),
      inputAmount: Amount.from(10),
      inputProofSecrets: ['other-proof'],
      revision: 0,
    };
    await repositories.sendOperationRepository.create(existing);

    await expect(transactions.prepare(command('send-conflict'))).rejects.toThrow(
      'Send operation id already exists',
    );

    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBeUndefined();
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(5);
    expect((await repositories.sendOperationRepository.getById('send-conflict'))?.state).toBe(
      'prepared',
    );
  });

  it('gives one concurrent reservation winner for the same authoritative proof', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('shared-proof')]);

    const results = await Promise.allSettled([
      transactions.prepare(command('send-a', false)),
      transactions.prepare(command('send-b', false)),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await repositories.sendOperationRepository.getByState('prepared')).toHaveLength(1);
    const storedProof = await repositories.proofRepository.getProofBySecret(
      mintUrl,
      'shared-proof',
    );
    expect(storedProof?.usedByOperationId).toBeDefined();
    expect(['send-a', 'send-b']).toContain(storedProof!.usedByOperationId!);
  });

  it('prepares a persisted legacy init row with a monotonic conditional revision', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('legacy-proof')]);
    const legacy = operation('legacy-send', false);
    delete legacy.revision;
    await repositories.sendOperationRepository.create(legacy);

    const result = await transactions.prepare({
      ...command('legacy-send', false),
      operation: legacy,
    });

    expect(result.operation.revision).toBe(1);
    const stored = await repositories.sendOperationRepository.getById('legacy-send');
    expect(stored?.state).toBe('prepared');
    expect(stored?.revision).toBe(1);
  });

  it('allocates distinct counter positions across concurrent preparations', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-a'), proof('proof-b')]);

    const results = await Promise.all([
      transactions.prepare(command('send-a')),
      transactions.prepare(command('send-b')),
    ]);
    const positions = results.map(
      (result) => result.operation.outputData!.send[0]!.blindedMessage.B_,
    );

    expect(new Set(positions).size).toBe(2);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(2);
  });

  it('uses the canonical fee-aware selector instead of consuming an uneconomic proof', async () => {
    const { repositories, transactions } = await setup();
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: 'expensive-keyset',
      unit: 'sat',
      keypairs: { 1: 'unused' },
      active: true,
      feePpk: 100_000,
    });
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: 'free-keyset',
      unit: 'sat',
      keypairs: { 1: 'unused' },
      active: true,
      feePpk: 0,
    });
    await repositories.proofRepository.saveProofs(mintUrl, [
      { ...proof('expensive-proof', 100), id: 'expensive-keyset' },
      { ...proof('free-proof', 10), id: 'free-keyset' },
    ]);

    const result = await transactions.prepare(command('fee-aware-send'));

    expect(result.operation.inputProofSecrets).toEqual(['free-proof']);
    expect(result.operation.inputAmount.equals(Amount.from(10))).toBe(true);
    expect(result.operation.fee.isZero()).toBe(true);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'expensive-proof'))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('finds a non-greedy exact subset without allocating swap outputs', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [
      proof('proof-8', 8),
      proof('proof-7', 7),
      proof('proof-3', 3),
    ]);

    const result = await transactions.prepare(command('exact-subset-send', false));

    expect(new Set(result.operation.inputProofSecrets)).toEqual(new Set(['proof-7', 'proof-3']));
    expect(result.operation.needsSwap).toBe(false);
    expect(result.operation.outputData).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it('rejects stale active key material before allocating or reserving anything', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);

    await expect(
      transactions.prepare({
        ...command('stale-keyset-send'),
        activeKeys: { ...keys, keys: { 1: 'stale-key' } },
      }),
    ).rejects.toThrow('changed after Send preflight');

    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.sendOperationRepository.getById('stale-keyset-send')).toBeNull();
  });
});
