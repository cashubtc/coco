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
import type {
  ExecuteExactSendCommand,
  PrepareSendCommand,
} from '../../transactions/send/TransactionalSendOperations.ts';
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

describe('SendTransactions exact-match execution', () => {
  async function prepareExact(
    id: string,
    repositories = new MemoryRepositories(),
  ): Promise<Awaited<ReturnType<typeof setup>>> {
    const environment = await setup(repositories);
    await environment.repositories.proofRepository.saveProofs(mintUrl, [proof('exact-proof')]);
    await environment.transactions.prepare(command(id, false));
    return environment;
  }

  function executeCommand(
    operationId: string,
    overrides: Partial<ExecuteExactSendCommand> = {},
  ): ExecuteExactSendCommand {
    return {
      operationId,
      expectedRevision: 0,
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

  it('rejects a stale revision without changing the prepared operation or proof', async () => {
    const { repositories, transactions } = await prepareExact('stale-exact-send');

    await expect(
      transactions.executeExact(executeCommand('stale-exact-send', { expectedRevision: 41 })),
    ).rejects.toThrow('state or revision conflict');

    expect((await repositories.sendOperationRepository.getById('stale-exact-send'))?.state).toBe(
      'prepared',
    );
    const storedProof = await repositories.proofRepository.getProofBySecret(mintUrl, 'exact-proof');
    expect(storedProof?.state).toBe('ready');
    expect(storedProof?.usedByOperationId).toBe('stale-exact-send');
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
      'does not own every ready input proof',
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
    const prepared = (await transactions.prepare(command('send-begin'))).operation;

    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      expectedRevision: prepared.revision ?? 0,
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

  it('leaves the complete request executing when a response is not applied', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(command('send-response-crash'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      expectedRevision: prepared.revision ?? 0,
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
    const prepared = (await transactions.prepare(command('send-concurrent-begin'))).operation;
    const begin = () =>
      transactions.beginExecution({
        operationId: prepared.id,
        expectedRevision: prepared.revision ?? 0,
        updatedAt: 300,
      });

    const results = await Promise.allSettled([begin(), begin()]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.revision).toBe(1);
  });

  it('atomically saves swap proofs, spends inputs, persists the token, and becomes pending', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(command('send-apply'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      expectedRevision: prepared.revision ?? 0,
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

    await expect(
      transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: (begun.operation.revision ?? 0) - 1,
        updatedAt: 350,
        keepProofs: [],
        sendProofs: [sendProof],
        token,
      }),
    ).rejects.toThrow('revision changed');
    expect((await repositories.sendOperationRepository.getById(prepared.id))?.state).toBe(
      'executing',
    );

    const applied = await transactions.applyResult({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision ?? 0,
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
      expectedRevision: begun.operation.revision ?? 0,
      updatedAt: 500,
      keepProofs: [],
      sendProofs: [sendProof],
      token,
    });
    expect(duplicate.committed).toBe(false);
    expect(duplicate.operation.revision).toBe(2);
  });

  it('rolls back every local result write when output persistence conflicts', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(command('send-apply-rollback'))).operation;
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      expectedRevision: prepared.revision ?? 0,
      updatedAt: 300,
    });
    const sendSecret = getSecretsFromSerializedOutputData(begun.request.outputData).sendSecrets[0]!;
    const sendProof = swapProof(begun.operation, sendSecret, 'inflight');
    await repositories.proofRepository.saveProofs(mintUrl, [proof(sendSecret, 1)]);

    await expect(
      transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
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

  it('atomically releases inputs on a definitive failure without reclaiming counters', async () => {
    const { repositories, transactions } = await setup();
    await repositories.proofRepository.saveProofs(mintUrl, [proof('proof-1')]);
    const prepared = (await transactions.prepare(command('send-fail'))).operation;
    const allocatedCounter = await repositories.counterRepository.getCounter(mintUrl, keysetId);
    const begun = await transactions.beginExecution({
      operationId: prepared.id,
      expectedRevision: prepared.revision ?? 0,
      updatedAt: 300,
    });

    const failed = await transactions.failExecution({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision ?? 0,
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

  it('atomically releases a prepared reservation and records cancellation', async () => {
    const repositories = new MemoryRepositories();
    const { transactions } = await setup(repositories);
    const prepared = await createPrepared(repositories, 'cancel-send');

    const cancelled = await transactions.cancelPrepared({
      operationId: prepared.id,
      expectedRevision: 0,
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
        expectedRevision: 0,
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
    const prepared = (await transactions.prepare(command('race-send'))).operation;

    const results = await Promise.allSettled([
      transactions.cancelPrepared({
        operationId: prepared.id,
        expectedRevision: prepared.revision ?? 0,
        updatedAt: 300,
        reason: 'Cancelled by user',
      }),
      transactions.beginExecution({
        operationId: prepared.id,
        expectedRevision: prepared.revision ?? 0,
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
      expectedRevision: 0,
      updatedAt: 300,
    });

    const completed = await transactions.completePending({
      operationId: pending.operation.id,
      expectedRevision: pending.operation.revision ?? 0,
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
      expectedRevision: pending.operation.revision ?? 0,
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
        expectedRevision: 1,
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
