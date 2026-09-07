import { testMintInfo } from '../fixtures/MintMetadata.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { Amount, type MintKeys, type OutputDataLike } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import {
  createSendOperation,
  type ExecutingSendOperation,
  type PendingSendOperation,
  type PreparedSendOperation,
} from '../../operations/send';
import type { RepositoryTransactionScope, SendOperationRepository } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  RepositoryCoreTransactionRunner,
  createCoreTransactionModuleFactory,
} from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
import type { ExecuteExactSendInput, PrepareSendInput } from '../../transactions/send/types.ts';
import type { CoreProof } from '../../types.ts';
import { getSecretsFromSerializedOutputData } from '../../utils.ts';
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

async function setup(repositories = new MemoryRepositories()) {
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
  const outputDataCreator = makeOutputDataCreator({
    createDeterministicData: (amount, _seed, counter) => [output(Amount.from(amount), counter)],
  });
  const runner = new RepositoryCoreTransactionRunner(
    repositories,
    createCoreTransactionModuleFactory(outputDataCreator),
  );
  return { repositories, transactions: new CoreSendTransactions(runner) };
}

class RejectingSendTransitionRepositories extends MemoryRepositories {
  override withTransaction<T>(
    fn: (repositories: RepositoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    return super.withTransaction((repositories) =>
      fn({
        ...repositories,
        sendOperationRepository: rejectTransitions(repositories.sendOperationRepository),
      }),
    );
  }
}

function rejectTransitions(repository: SendOperationRepository): SendOperationRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'transition') return async () => false;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function prepareInput(id: string, forceSwap = true): PrepareSendInput {
  return {
    operation: operation(id, forceSwap),
    activeKeys: keys,
    seed: new Uint8Array(32).fill(1),
    forceSwap,
  };
}

describe('SendTransactions preparation', () => {
  it('reserves proofs, allocates outputs, advances the counter, and creates prepared atomically', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);

    const result = await transactions.prepare(prepareInput('send-1'));

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

    await expect(transactions.prepare(prepareInput('send-conflict'))).rejects.toThrow(
      'Send operation id send-conflict already exists',
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
      transactions.prepare(prepareInput('send-a', false)),
      transactions.prepare(prepareInput('send-b', false)),
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

  it('rejects a persisted legacy init row before mutating proofs or counters', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('legacy-proof')]);
    await repositories.counterRepository.setCounter(mintUrl, keysetId, 5);
    const legacy = operation('legacy-send');
    delete legacy.revision;
    await repositories.sendOperationRepository.create(legacy);

    await expect(
      transactions.prepare({ ...prepareInput('legacy-send'), operation: legacy }),
    ).rejects.toThrow('Send operation id legacy-send already exists');

    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'legacy-proof'))
        ?.usedByOperationId,
    ).toBeUndefined();
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(5);
    const stored = await repositories.sendOperationRepository.getById('legacy-send');
    expect(stored?.state).toBe('init');
    expect(stored?.revision).toBe(0);
  });

  it('allocates distinct counter positions across concurrent preparations', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-a'), proof('proof-b')]);

    const results = await Promise.all([
      transactions.prepare(prepareInput('send-a')),
      transactions.prepare(prepareInput('send-b')),
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

    const result = await transactions.prepare(prepareInput('fee-aware-send'));

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

    const result = await transactions.prepare(prepareInput('exact-subset-send', false));

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
        ...prepareInput('stale-keyset-send'),
        activeKeys: { ...keys, keys: { 1: 'stale-key' } },
      }),
    ).rejects.toThrow('changed after preflight');

    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
    expect(await repositories.sendOperationRepository.getById('stale-keyset-send')).toBeNull();
  });
});

describe('SendTransactions exact-match execution', () => {
  async function prepareExact(
    id: string,
    repositories = new MemoryRepositories(),
  ): Promise<Awaited<ReturnType<typeof setup>>> {
    const environment = await setup(repositories);
    await environment.repositories.proofRepository.saveProofs(mintUrl, [proof('exact-proof')]);
    await environment.transactions.prepare(prepareInput(id, false));
    return environment;
  }

  function executeCommand(
    operationId: string,
    overrides: Partial<ExecuteExactSendInput> = {},
  ): ExecuteExactSendInput {
    return {
      operationId,
      updatedAt: 300,
      ...overrides,
    };
  }

  it('commits proof state, complete token data, and prepared-to-pending together', async () => {
    const { repositories, transactions } = await prepareExact('exact-send');

    const result = await transactions.executeExact(
      executeCommand('exact-send', { memo: '  exact memo  ' }),
    );

    expect(result.committed).toBe(true);
    expect(result.operation.state).toBe('pending');
    expect(result.operation.revision).toBe(1);
    expect(result.token.memo).toBe('exact memo');
    expect(result.token.proofs.map((candidate) => candidate.secret)).toEqual(['exact-proof']);
    const stored = await repositories.sendOperationRepository.getById('exact-send');
    expect(stored?.state).toBe('pending');
    expect(stored?.revision).toBe(1);
    expect((stored as typeof result.operation).token.proofs).toHaveLength(1);
    const storedProof = await repositories.proofRepository.getProofBySecret(mintUrl, 'exact-proof');
    expect(storedProof?.state).toBe('inflight');
    expect(storedProof?.usedByOperationId).toBe('exact-send');
    expect(await repositories.sendOperationRepository.getByState('executing')).toEqual([]);
  });

  it('advances the authoritative revision without accepting one from the caller', async () => {
    const { repositories, transactions } = await prepareExact('revisioned-exact-send');
    const prepared = await repositories.sendOperationRepository.getById('revisioned-exact-send');
    if (!prepared || prepared.state !== 'prepared') throw new Error('prepared operation missing');
    await repositories.sendOperationRepository.update({ ...prepared, revision: 5 });

    const result = await transactions.executeExact(executeCommand(prepared.id));

    expect(result.operation.revision).toBe(6);
  });

  it('rolls back the inflight proof write when the final operation transition loses', async () => {
    const repositories = new RejectingSendTransitionRepositories();
    const environment = await prepareExact('rejected-exact-send', repositories);

    await expect(
      environment.transactions.executeExact(executeCommand('rejected-exact-send')),
    ).rejects.toThrow('state or revision conflict');

    expect((await repositories.sendOperationRepository.getById('rejected-exact-send'))?.state).toBe(
      'prepared',
    );
    const storedProof = await repositories.proofRepository.getProofBySecret(mintUrl, 'exact-proof');
    expect(storedProof?.state).toBe('ready');
    expect(storedProof?.usedByOperationId).toBe('rejected-exact-send');
  });

  it('has one transition winner and returns the identical committed result to a duplicate', async () => {
    const { repositories, transactions } = await prepareExact('concurrent-exact-send');
    const request = executeCommand('concurrent-exact-send', { memo: 'same memo' });

    const results = await Promise.all([
      transactions.executeExact(request),
      transactions.executeExact(request),
    ]);

    expect(results.filter((result) => result.committed)).toHaveLength(1);
    expect(results.filter((result) => !result.committed)).toHaveLength(1);
    expect(results[0]?.token).toEqual(results[1]?.token);
    expect(
      (await repositories.sendOperationRepository.getById('concurrent-exact-send'))?.revision,
    ).toBe(1);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'exact-proof'))?.state,
    ).toBe('inflight');
  });

  it('rejects execution when a prepared input is no longer ready and owned', async () => {
    const { repositories, transactions } = await prepareExact('unowned-exact-send');
    await repositories.proofRepository.releaseProofs(mintUrl, ['exact-proof']);

    await expect(transactions.executeExact(executeCommand('unowned-exact-send'))).rejects.toThrow(
      'not ready and operation-owned',
    );

    expect((await repositories.sendOperationRepository.getById('unowned-exact-send'))?.state).toBe(
      'prepared',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'exact-proof'))?.state,
    ).toBe('ready');
  });
});

function swapProof(
  operation: ExecutingSendOperation,
  secret: string,
  state: CoreProof['state'],
): CoreProof {
  return {
    id: keysetId,
    secret,
    amount: operation.amount,
    C: `C-${secret}`,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    state,
    createdByOperationId: operation.id,
  };
}

describe('SendTransactions swap execution', () => {
  it('commits the exact executing request and memo before transport starts', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-begin'))).operation;

    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
      memo: 'durable memo',
    });

    const stored = await repositories.sendOperationRepository.getById(prepared.id);
    expect(stored?.state).toBe('executing');
    expect(stored?.revision).toBe(1);
    expect(stored?.executionMemo).toBe('durable memo');
    expect(begun.request.inputProofs.map((candidate) => candidate.secret)).toEqual(['proof-1']);
    expect(begun.request.outputData).toEqual(prepared.outputData!);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBe(prepared.id);
  });

  it('keeps persisted inputs and outputs independent of returned and queried request objects', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('request-input')]);
    const prepared = await transactions.prepare(prepareInput('request-immutability'));
    const begun = await transactions.beginExecution({
      operationId: prepared.operation.id,
      updatedAt: 300,
    });
    const expected = JSON.stringify(begun.request.outputData);
    begun.request.outputData.send[0]!.secret = 'changed';
    const queried = await repositories.sendOperationRepository.getById(prepared.operation.id);
    if (!queried || queried.state !== 'executing') throw new Error('Missing executing operation');
    expect(JSON.stringify(queried.outputData)).toBe(expected);
    queried.inputProofSecrets.push('changed');
    queried.outputData!.send[0]!.secret = 'changed';
    const replay = await transactions.claimRecovery({
      operationId: prepared.operation.id,
      expectedRevision: queried.revision!,
      updatedAt: 400,
    });
    expect(JSON.stringify(replay.request.outputData)).toBe(expected);
    expect(replay.request.inputProofs.map((proof) => proof.secret)).toEqual(['request-input']);
  });

  it('leaves the complete request executing when a response is not applied', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-response-crash'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
    });
    const sendSecret = getSecretsFromSerializedOutputData(begun.request.outputData).sendSecrets[0]!;

    // A remote response may now exist, but no local result transaction has run.
    const response = { send: [swapProof(begun.operation, sendSecret, 'inflight')], keep: [] };
    expect(response.send).toHaveLength(1);
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, sendSecret)).toBeNull();
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.state).toBe(
      'ready',
    );
  });

  it('gives only one concurrent begin attempt authority to contact the mint', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-concurrent-begin'))).operation;
    const begin = () =>
      transactions.beginExecution({
        operationId: prepared.id,
        updatedAt: 300,
      });

    const results = await Promise.allSettled([begin(), begin()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.revision).toBe(1);
  });

  it('gives only one recovery caller authority to replay an executing revision', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-recovery-claim'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
    });
    const claim = () =>
      transactions.claimRecovery({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
        updatedAt: 400,
      });

    const results = await Promise.allSettled([claim(), claim()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.revision).toBe(2);
  });

  it('atomically saves swap proofs, spends inputs, persists the token, and becomes pending', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-apply'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
      memo: 'memo',
    });
    const sendSecret = getSecretsFromSerializedOutputData(begun.request.outputData).sendSecrets[0]!;
    const sendProof = swapProof(begun.operation, sendSecret, 'inflight');
    const token = {
      mint: mintUrl,
      proofs: [sendProof],
      unit: 'sat',
      memo: 'memo',
    };

    const applied = await transactions.applyResult({
      operationId: begun.operation.id,
      updatedAt: 400,
      keepProofs: [],
      sendProofs: [sendProof],
      token,
    });

    expect(applied.committed).toBe(true);
    expect(applied.operation.state).toBe('pending');
    expect(applied.operation.revision).toBe(2);
    expect(applied.operation.token).toEqual(token);
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.state).toBe(
      'spent',
    );
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, sendSecret))?.state).toBe(
      'inflight',
    );

    const duplicate = await transactions.applyResult({
      operationId: begun.operation.id,
      updatedAt: 500,
      keepProofs: [],
      sendProofs: [sendProof],
      token,
    });
    expect(duplicate.committed).toBe(false);
    expect(duplicate.operation.revision).toBe(2);
  });

  it('rejects swap proofs that do not match the exact persisted output allocation', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-invalid-allocation')))
      .operation;
    const begun = await transactions.beginExecution({ operationId: prepared.id, updatedAt: 300 });
    const sendSecret = getSecretsFromSerializedOutputData(begun.request.outputData).sendSecrets[0]!;
    const allocated = swapProof(begun.operation, sendSecret, 'inflight');
    const token = { mint: mintUrl, proofs: [allocated], unit: 'sat' };
    const invalidProofs = [
      { ...allocated, id: 'wrong-keyset' },
      { ...allocated, amount: allocated.amount.add(Amount.from(1)) },
    ];

    for (const invalid of invalidProofs) {
      await expect(
        transactions.applyResult({
          operationId: begun.operation.id,
          updatedAt: 400,
          keepProofs: [],
          sendProofs: [invalid],
          token: { ...token, proofs: [invalid] },
        }),
      ).rejects.toThrow('do not match allocated outputs');
    }
    await expect(
      transactions.applyResult({
        operationId: begun.operation.id,
        updatedAt: 400,
        keepProofs: [{ ...allocated, state: 'ready' }],
        sendProofs: [],
        token: { ...token, proofs: [] },
      }),
    ).rejects.toThrow('do not match allocated outputs');
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );
  });

  it('rolls back every local result write when output persistence conflicts', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-apply-rollback'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
    });
    const sendSecret = getSecretsFromSerializedOutputData(begun.request.outputData).sendSecrets[0]!;
    const sendProof = swapProof(begun.operation, sendSecret, 'inflight');
    await repositories.proofRepository.saveProofs(mintUrl, [proof(sendSecret, 1)]);

    await expect(
      transactions.applyResult({
        operationId: begun.operation.id,
        updatedAt: 400,
        keepProofs: [],
        sendProofs: [sendProof],
        token: { mint: mintUrl, proofs: [sendProof], unit: 'sat' },
      }),
    ).rejects.toThrow('already exists');

    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );
    expect((await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.state).toBe(
      'ready',
    );
  });

  it('rejects an initial failure after recovery has claimed its executing revision', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-stale-failure'))).operation;
    const begun = await transactions.beginExecution({ operationId: prepared.id, updatedAt: 300 });
    await transactions.claimRecovery({
      operationId: prepared.id,
      expectedRevision: begun.operation.revision!,
      updatedAt: 400,
    });

    await expect(
      transactions.failExecution({
        operationId: prepared.id,
        expectedRevision: begun.operation.revision!,
        updatedAt: 500,
        error: 'keyset rejected',
      }),
    ).rejects.toThrow('revision conflict');

    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBe(prepared.id);
  });

  it('atomically releases inputs on a definitive failure without reclaiming counters', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(prepareInput('send-fail'))).operation;
    const allocatedCounter = await repositories.counterRepository.getCounter(mintUrl, keysetId);
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      updatedAt: 300,
    });

    const failed = await transactions.failExecution({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision!,
      updatedAt: 400,
      error: 'Keyset rejected',
    });

    expect(failed.operation.state).toBe('rolled_back');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'proof-1'))?.usedByOperationId,
    ).toBeUndefined();
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toEqual(
      allocatedCounter,
    );
  });
});

describe('SendTransactions cancellation and completion', () => {
  async function createPrepared(
    repositories: MemoryRepositories,
    id: string,
  ): Promise<PreparedSendOperation> {
    const input = proof(`${id}-input`);
    await repositories.proofRepository.saveProofs(mintUrl, [input]);
    await repositories.proofRepository.reserveProofs(mintUrl, [input.secret], id);
    const prepared: PreparedSendOperation = {
      ...operation(id, false),
      state: 'prepared',
      revision: 0,
      needsSwap: false,
      fee: Amount.zero(),
      inputAmount: Amount.from(10),
      inputProofSecrets: [input.secret],
    };
    await repositories.sendOperationRepository.create(prepared);
    return prepared;
  }

  it('releases terminal Send reservations while preserving active and unidentified owners', async () => {
    const repositories = new MemoryRepositories();
    const { transactions } = await setup(repositories);
    const active = await createPrepared(repositories, 'active-send');
    const terminal = await createPrepared(repositories, 'terminal-send');
    await repositories.sendOperationRepository.update({
      ...terminal,
      state: 'rolled_back',
      error: 'already terminal',
    });
    const orphan = proof('orphan-input');
    await repositories.proofRepository.saveProofs(mintUrl, [orphan]);
    await repositories.proofRepository.reserveProofs(mintUrl, [orphan.secret], 'missing-send');

    const meltInput = proof('melt-input');
    await repositories.proofRepository.saveProofs(mintUrl, [meltInput]);
    await repositories.meltOperationRepository.create({
      id: 'prepared-melt',
      mintUrl,
      unit: 'sat',
      state: 'prepared',
      method: 'bolt11',
      methodData: { invoice: 'test-invoice' },
      createdAt: 100,
      updatedAt: 100,
      needsSwap: false,
      amount: Amount.from(10),
      fee_reserve: Amount.zero(),
      swap_fee: Amount.zero(),
      quoteId: 'melt-quote',
      inputAmount: Amount.from(10),
      inputProofSecrets: [meltInput.secret],
      changeOutputData: { keep: [], send: [] },
    });
    await repositories.proofRepository.reserveProofs(mintUrl, [meltInput.secret], 'prepared-melt');

    const result = await transactions.cleanupOrphanedReservations();

    expect(result.count).toBe(1);
    expect(result.released).toEqual([
      {
        mintUrl,
        secrets: [terminal.inputProofSecrets[0]!],
      },
    ]);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, active.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBe(active.id);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, terminal.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBeUndefined();
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, orphan.secret))
        ?.usedByOperationId,
    ).toBe('missing-send');
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, meltInput.secret))
        ?.usedByOperationId,
    ).toBe('prepared-melt');
  });

  it('atomically releases a prepared reservation and records cancellation', async () => {
    const repositories = new MemoryRepositories();
    const { transactions } = await setup(repositories);
    const prepared = await createPrepared(repositories, 'cancel-send');

    const cancelled = await transactions.cancelPrepared({
      operationId: prepared.id,
      updatedAt: 300,
      reason: 'Cancelled by user',
    });

    expect(cancelled.operation.state).toBe('rolled_back');
    expect(cancelled.operation.revision).toBe(1);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBeUndefined();
  });

  it('rolls back reservation release when cancellation loses its final transition', async () => {
    const repositories = new RejectingSendTransitionRepositories();
    const { transactions } = await setup(repositories);
    const prepared = await createPrepared(repositories, 'cancel-conflict');

    await expect(
      transactions.cancelPrepared({
        operationId: prepared.id,
        updatedAt: 300,
        reason: 'Cancelled by user',
      }),
    ).rejects.toThrow('prepared-state or revision conflict');

    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'prepared',
    );
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, prepared.inputProofSecrets[0]!))
        ?.usedByOperationId,
    ).toBe(prepared.id);
  });

  it('allows only cancellation or swap execution to win from the same prepared revision', async () => {
    const repositories = new MemoryRepositories();
    const { transactions } = await setup(repositories);
    await repositories.proofRepository.saveProofs(mintUrl, [proof('race-input')]);
    const prepared = (await transactions.prepare(prepareInput('race-send'))).operation;

    const results = await Promise.allSettled([
      transactions.cancelPrepared({
        operationId: prepared.id,
        updatedAt: 300,
        reason: 'Cancelled by user',
      }),
      transactions.beginExecution({
        operationId: prepared.id,
        updatedAt: 300,
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await repositories.sendOperationRepository.getById(prepared.id);
    expect(stored).not.toBeNull();
    expect(['executing', 'rolled_back']).toContain(stored!.state);
    const input = await repositories.proofRepository.getProofBySecret(mintUrl, 'race-input');
    expect(input?.usedByOperationId).toBe(stored?.state === 'executing' ? prepared.id : undefined);
  });

  it('commits the last spent observation, reservation release, and final state together', async () => {
    const repositories = new MemoryRepositories();
    const { transactions } = await setup(repositories);
    const prepared = await createPrepared(repositories, 'complete-send');
    const pending = await transactions.executeExact({
      operationId: prepared.id,
      updatedAt: 300,
    });

    const completed = await transactions.completePending({
      operationId: pending.operation.id,
      updatedAt: 400,
      spentProofSecrets: pending.operation.inputProofSecrets,
    });

    expect(completed.operation.state).toBe('finalized');
    expect(completed.operation.revision).toBe(2);
    const input = await repositories.proofRepository.getProofBySecret(
      mintUrl,
      pending.operation.inputProofSecrets[0]!,
    );
    expect(input?.state).toBe('spent');
    expect(input?.usedByOperationId).toBeUndefined();

    const duplicate = await transactions.completePending({
      operationId: pending.operation.id,
      updatedAt: 500,
      spentProofSecrets: pending.operation.inputProofSecrets,
    });
    expect(duplicate.committed).toBe(false);
  });

  it('rolls back proof completion when the pending terminal transition loses', async () => {
    const repositories = new RejectingSendTransitionRepositories();
    const { transactions } = await setup(repositories);
    const input = proof('terminal-conflict-input');
    await repositories.proofRepository.saveProofs(mintUrl, [
      { ...input, state: 'inflight', usedByOperationId: 'terminal-conflict' },
    ]);
    const pending: PendingSendOperation = {
      ...operation('terminal-conflict', false),
      state: 'pending',
      revision: 1,
      needsSwap: false,
      fee: Amount.zero(),
      inputAmount: Amount.from(10),
      inputProofSecrets: [input.secret],
      token: { mint: mintUrl, proofs: [input], unit: 'sat' },
    };
    await repositories.sendOperationRepository.create(pending);

    await expect(
      transactions.completePending({
        operationId: pending.id,
        updatedAt: 400,
        spentProofSecrets: [input.secret],
      }),
    ).rejects.toThrow('pending-state or revision conflict');

    expect((await repositories.sendOperationRepository.getById(pending.id))?.state).toBe('pending');
    const storedInput = await repositories.proofRepository.getProofBySecret(mintUrl, input.secret);
    expect(storedInput?.state).toBe('inflight');
    expect(storedInput?.usedByOperationId).toBe(pending.id);
  });
});

describe('SendTransactions reclaim', () => {
  async function pending(repositories = new MemoryRepositories()) {
    const environment = await setup(repositories);
    await repositories.proofRepository.saveProofs(mintUrl, [proof('reclaim-input')]);
    const prepared = await environment.transactions.prepare(prepareInput('reclaim-send', false));
    const result = await environment.transactions.executeExact({
      operationId: prepared.operation.id,
      updatedAt: 300,
    });
    return { ...environment, operation: result.operation };
  }

  function reclaimProofs(
    outputData: NonNullable<PendingSendOperation['reclaimData']>['outputData'],
  ): CoreProof[] {
    const secrets = getSecretsFromSerializedOutputData(outputData).keepSecrets;
    return outputData.keep.map((output, index) => ({
      ...proof(secrets[index]!),
      amount: Amount.from(output.blindedMessage.amount),
      id: output.blindedMessage.id,
    }));
  }

  it('commits reclaim allocation with rolling_back and atomically applies its proofs and releases inputs', async () => {
    const { repositories, transactions, operation } = await pending();
    const begun = await transactions.beginReclaim({
      operationId: operation.id,
      updatedAt: 400,
      activeKeys: keys,
      seed: new Uint8Array(32),
    });
    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('rolling_back');
    expect(stored?.reclaimData).toEqual(begun.operation.reclaimData);
    expect(begun.counter?.counter).toBe(1);
    expect(
      (await repositories.proofRepository.getProofBySecret(mintUrl, 'reclaim-input'))?.state,
    ).toBe('inflight');

    const proofs = reclaimProofs(begun.operation.reclaimData!.outputData);
    const completed = await transactions.completeReclaim({
      operationId: operation.id,
      updatedAt: 500,
      reason: 'reclaimed',
      proofs,
    });
    expect(completed.operation.state).toBe('rolled_back');
    expect(completed.operation.token).toEqual(operation.token);
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual(proofs);
    const input = await repositories.proofRepository.getProofBySecret(mintUrl, 'reclaim-input');
    expect(input?.state).toBe('spent');
    expect(input?.usedByOperationId).toBeUndefined();
  });

  it('rolls back reclaim allocation when the pending-state transition conflicts', async () => {
    const { repositories, operation } = await pending();
    const rejecting = new CoreSendTransactions(
      new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (fn) =>
          repositories.withTransaction((scope) =>
            fn({
              ...scope,
              sendOperationRepository: rejectTransitions(scope.sendOperationRepository),
            }),
          ),
        ),
      ),
    );
    await expect(
      rejecting.beginReclaim({
        operationId: operation.id,
        updatedAt: 400,
        activeKeys: keys,
        seed: new Uint8Array(32),
      }),
    ).rejects.toThrow('conflict');
    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'pending',
    );
    expect(await repositories.counterRepository.getCounter(mintUrl, keysetId)).toBeNull();
  });

  it('preserves allocation and every input when applying a reclaim result loses its transition', async () => {
    const { repositories, transactions, operation } = await pending();
    const begun = await transactions.beginReclaim({
      operationId: operation.id,
      updatedAt: 400,
      activeKeys: keys,
      seed: new Uint8Array(32),
    });
    const rejecting = new CoreSendTransactions(
      new RepositoryCoreTransactionRunner(
        overrideTransactions(repositories, (fn) =>
          repositories.withTransaction((scope) =>
            fn({
              ...scope,
              sendOperationRepository: rejectTransitions(scope.sendOperationRepository),
            }),
          ),
        ),
      ),
    );
    await expect(
      rejecting.completeReclaim({
        operationId: operation.id,
        updatedAt: 500,
        reason: 'reclaimed',
        proofs: reclaimProofs(begun.operation.reclaimData!.outputData),
      }),
    ).rejects.toThrow('conflict');
    const stored = await repositories.sendOperationRepository.getById(operation.id);
    expect(stored?.state).toBe('rolling_back');
    expect(stored?.reclaimData).toEqual(begun.operation.reclaimData);
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
    const input = await repositories.proofRepository.getProofBySecret(mintUrl, 'reclaim-input');
    expect(input?.state).toBe('inflight');
    expect(input?.usedByOperationId).toBe(operation.id);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
  });

  it('rejects returned proofs that differ from the committed reclaim plan', async () => {
    const { repositories, transactions, operation } = await pending();
    await transactions.beginReclaim({
      operationId: operation.id,
      updatedAt: 400,
      activeKeys: keys,
      seed: new Uint8Array(32),
    });
    await expect(
      transactions.completeReclaim({
        operationId: operation.id,
        updatedAt: 500,
        reason: 'reclaimed',
        proofs: [proof('unexpected')],
      }),
    ).rejects.toThrow('allocated outputs');
    expect((await repositories.sendOperationRepository.getById(operation.id))?.state).toBe(
      'rolling_back',
    );
    expect(await repositories.proofRepository.getAvailableProofs(mintUrl)).toEqual([]);
  });
});
