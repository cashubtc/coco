import { Amount, type MintKeys, type OutputDataLike, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { createReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationRepository, RepositoryTransactionScope } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { CoreProof } from '../../types.ts';
import {
  RepositoryCoreTransactionRunner,
  createCoreTransactionModuleFactory,
} from '../../transactions/CoreTransaction.ts';
import { CoreReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import { getSecretsFromSerializedOutputData } from '../../utils.ts';
import { makeOutputDataCreator } from '../fixtures/OutputDataCreator.ts';

const mintUrl = 'https://mint.test';
const keysetId = 'keyset-1';
const keys = { id: keysetId, unit: 'sat', keys: { 1: 'unused' } } as MintKeys;

function inputProof(secret: string, witness?: string): Proof {
  return {
    id: keysetId,
    amount: Amount.from(10),
    secret,
    C: `C-${secret}`,
    witness,
  } as Proof;
}

function output(amount: Amount, counter: number): OutputDataLike {
  return {
    blindedMessage: { amount, id: keysetId, B_: `B-${counter}` },
    blindingFactor: BigInt(counter + 1),
    secret: new TextEncoder().encode(`output-${counter}`),
    toProof: () => {
      throw new Error('not used');
    },
  };
}

function operation(id: string, proof = inputProof(`input-${id}`)) {
  const created = createReceiveOperation(id, mintUrl, { amount: Amount.from(10), unit: 'sat' }, [
    proof,
  ]);
  return { ...created, createdAt: 100, updatedAt: 200 };
}

async function setup(
  repositories = new MemoryRepositories(),
  outputDataCreator = makeOutputDataCreator({
    createDeterministicData: (amount, _seed, counter) => [output(Amount.from(amount), counter)],
  }),
) {
  await repositories.keysetRepository.addKeyset({
    mintUrl,
    id: keysetId,
    unit: 'sat',
    keypairs: { 1: 'unused' },
    active: true,
    feePpk: 0,
  });
  const runner = new RepositoryCoreTransactionRunner(
    repositories,
    createCoreTransactionModuleFactory(outputDataCreator),
  );
  return { repositories, transactions: new CoreReceiveTransactions(runner) };
}

function command(id: string, proof?: Proof) {
  return {
    operation: operation(id, proof),
    activeKeys: keys,
    seed: new Uint8Array(64).fill(1),
    fee: Amount.zero(),
  };
}

class RejectingReceiveCreateRepositories extends MemoryRepositories {
  override withTransaction<T>(
    fn: (repositories: RepositoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    return super.withTransaction((repositories) =>
      fn({
        ...repositories,
        receiveOperationRepository: rejectCreates(repositories.receiveOperationRepository),
      }),
    );
  }
}

function rejectCreates(repository: ReceiveOperationRepository): ReceiveOperationRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'create') return async () => Promise.reject(new Error('persist failed'));
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

class RejectingReceiveFinalizeRepositories extends MemoryRepositories {
  override withTransaction<T>(
    fn: (repositories: RepositoryTransactionScope) => Promise<T>,
  ): Promise<T> {
    return super.withTransaction((repositories) =>
      fn({
        ...repositories,
        receiveOperationRepository: rejectFinalization(repositories.receiveOperationRepository),
      }),
    );
  }
}

function rejectFinalization(repository: ReceiveOperationRepository): ReceiveOperationRepository {
  return new Proxy(repository, {
    get(target, property) {
      if (property === 'transition') {
        return async (transition: Parameters<ReceiveOperationRepository['transition']>[0]) => {
          if (transition.next.state === 'finalized') throw new Error('finalization failed');
          return target.transition(transition);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function receivedProof(secret: string, operationId: string): CoreProof {
  return {
    id: keysetId,
    amount: Amount.from(10),
    secret,
    C: `C-${secret}`,
    mintUrl,
    unit: 'sat',
    state: 'ready',
    createdByOperationId: operationId,
  };
}

async function prepareAndBegin(
  environment: Awaited<ReturnType<typeof setup>>,
  operationId: string,
) {
  const prepared = await environment.transactions.prepare(command(operationId));
  const begun = await environment.transactions.beginExecution({
    operationId,
    expectedRevision: prepared.operation.revision ?? 0,
    updatedAt: 300,
  });
  return { prepared, begun };
}

describe('ReceiveTransactions preparation', () => {
  it('persists the exact signed inputs with allocation and counter in one prepared row', async () => {
    const { repositories, transactions } = await setup();
    const signed = inputProof('p2pk-input', '{"signatures":["signed-once"]}');

    const result = await transactions.prepare(command('receive-p2pk', signed));

    expect(result.operation.state).toBe('prepared');
    expect(result.operation.revision).toBe(0);
    expect(result.operation.inputProofs).toEqual([signed]);
    const stored = await repositories.receiveOperationRepository.getById('receive-p2pk');
    expect(stored?.inputProofs).toEqual([signed]);
    expect(await repositories.receiveOperationRepository.getByState('init')).toEqual([]);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(1);
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, signed.secret)).toBeNull();
  });

  it('rolls back counter allocation when prepared operation persistence fails', async () => {
    const repositories = new RejectingReceiveCreateRepositories();
    const environment = await setup(repositories);
    await repositories.counterRepository.setCounter(mintUrl, keysetId, 5);

    await expect(environment.transactions.prepare(command('receive-failed'))).rejects.toThrow(
      'persist failed',
    );

    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(5);
    expect(await repositories.receiveOperationRepository.getById('receive-failed')).toBeNull();
  });

  it('allocates unique deterministic outputs across concurrent preparations', async () => {
    const { repositories, transactions } = await setup();

    const results = await Promise.all([
      transactions.prepare(command('receive-a')),
      transactions.prepare(command('receive-b')),
    ]);
    const secrets = results.map(
      (result) => getSecretsFromSerializedOutputData(result.operation.outputData).keepSecrets[0],
    );

    expect(new Set(secrets).size).toBe(2);
    expect((await repositories.counterRepository.getCounter(mintUrl, keysetId))?.counter).toBe(2);
  });

  it('prepares a persisted legacy init row with a monotonic conditional revision', async () => {
    const { repositories, transactions } = await setup();
    const legacy = operation('legacy-receive');
    delete legacy.revision;
    await repositories.receiveOperationRepository.create(legacy);

    const result = await transactions.prepare({ ...command(legacy.id), operation: legacy });

    expect(result.operation.revision).toBe(1);
    expect((await repositories.receiveOperationRepository.getById(legacy.id))?.revision).toBe(1);
  });
});

describe('ReceiveTransactions execution', () => {
  it('commits executing before exposing the exact durable transport request', async () => {
    const environment = await setup();
    const signed = inputProof('signed-input', '{"signatures":["signed-once"]}');
    const prepared = await environment.transactions.prepare(command('receive-begin', signed));

    const begun = await environment.transactions.beginExecution({
      operationId: prepared.operation.id,
      expectedRevision: prepared.operation.revision ?? 0,
      updatedAt: 300,
    });

    expect(
      (await environment.repositories.receiveOperationRepository.getById(prepared.operation.id))
        ?.state,
    ).toBe('executing');
    expect(begun.operation.revision).toBe(1);
    expect(begun.request.inputProofs).toEqual([signed]);
    expect(begun.request.outputData).toEqual(prepared.operation.outputData);
  });

  it('rolls back proof insertion when the final operation transition fails', async () => {
    const repositories = new RejectingReceiveFinalizeRepositories();
    const environment = await setup(repositories);
    const { begun } = await prepareAndBegin(environment, 'receive-rollback');
    const secret = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets[0]!;

    await expect(
      environment.transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
        updatedAt: 400,
        proofs: [receivedProof(secret, begun.operation.id)],
      }),
    ).rejects.toThrow('finalization failed');

    expect((await repositories.receiveOperationRepository.getById(begun.operation.id))?.state).toBe(
      'executing',
    );
    expect(await repositories.proofRepository.getProofBySecret(mintUrl, secret)).toBeNull();
  });

  it('atomically records a definitive proofs-already-spent failure', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-spent');

    const failed = await environment.transactions.failExecution({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision ?? 0,
      updatedAt: 400,
      error: 'Proofs already spent',
    });

    expect(failed.committed).toBe(true);
    expect(failed.operation.state).toBe('rolled_back');
    expect(failed.operation.error).toBe('Proofs already spent');
    expect(
      await environment.repositories.proofRepository.getProofsByOperationId(
        mintUrl,
        begun.operation.id,
      ),
    ).toEqual([]);
  });

  it('records exact restored outputs as spent while finalizing a proven successful receive', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-restored-spent');
    const secret = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets[0]!;

    const applied = await environment.transactions.applyResult({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision ?? 0,
      updatedAt: 400,
      proofs: [{ ...receivedProof(secret, begun.operation.id), state: 'spent' }],
    });

    expect(applied.operation.state).toBe('finalized');
    expect(
      (await environment.repositories.proofRepository.getProofBySecret(mintUrl, secret))?.state,
    ).toBe('spent');
  });

  it('reconciles a partially saved restored result to its proven spent state', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-partial-restored-spent');
    const secret = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets[0]!;
    const restoredProof = receivedProof(secret, begun.operation.id);
    await environment.repositories.proofRepository.saveProofs(mintUrl, [restoredProof]);

    await environment.transactions.applyResult({
      operationId: begun.operation.id,
      expectedRevision: begun.operation.revision ?? 0,
      updatedAt: 400,
      proofs: [{ ...restoredProof, state: 'spent' }],
    });

    expect(
      (await environment.repositories.proofRepository.getProofBySecret(mintUrl, secret))?.state,
    ).toBe('spent');
  });

  it('conditionally cancels a prepared Receive without a generic write escape hatch', async () => {
    const environment = await setup();
    const prepared = await environment.transactions.prepare(command('receive-cancel'));

    const cancelled = await environment.transactions.cancelPrepared({
      operationId: prepared.operation.id,
      expectedRevision: prepared.operation.revision ?? 0,
      updatedAt: 300,
      error: 'User cancelled receive operation',
    });
    const duplicate = await environment.transactions.cancelPrepared({
      operationId: prepared.operation.id,
      expectedRevision: prepared.operation.revision ?? 0,
      updatedAt: 300,
      error: 'User cancelled receive operation',
    });

    expect(cancelled.committed).toBe(true);
    expect(duplicate.committed).toBe(false);
    expect(duplicate.operation.revision).toBe(1);
  });

  it('rejects a returned proof from a different keyset than its allocated output', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-wrong-keyset');
    const secret = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets[0]!;
    const proof = { ...receivedProof(secret, begun.operation.id), id: 'wrong-keyset' };

    await expect(
      environment.transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
        updatedAt: 400,
        proofs: [proof],
      }),
    ).rejects.toThrow('Receive proofs do not match the allocated outputs');

    expect(
      (await environment.repositories.receiveOperationRepository.getById(begun.operation.id))
        ?.state,
    ).toBe('executing');
    expect(
      await environment.repositories.proofRepository.getProofBySecret(mintUrl, secret),
    ).toBeNull();
  });

  it('rejects proofs whose denominations are swapped between allocated secrets', async () => {
    const outputDataCreator = makeOutputDataCreator({
      createDeterministicData: (_amount, _seed, counter) => [
        output(Amount.from(2), counter),
        output(Amount.from(8), counter + 1),
      ],
    });
    const environment = await setup(new MemoryRepositories(), outputDataCreator);
    const { begun } = await prepareAndBegin(environment, 'receive-swapped-amounts');
    const secrets = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets;

    await expect(
      environment.transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
        updatedAt: 400,
        proofs: [
          { ...receivedProof(secrets[0]!, begun.operation.id), amount: Amount.from(8) },
          { ...receivedProof(secrets[1]!, begun.operation.id), amount: Amount.from(2) },
        ],
      }),
    ).rejects.toThrow('Receive proofs do not match the allocated outputs');

    expect(
      (await environment.repositories.receiveOperationRepository.getById(begun.operation.id))
        ?.state,
    ).toBe('executing');
    expect(
      await environment.repositories.proofRepository.getProofsBySecrets(mintUrl, secrets),
    ).toEqual([]);
  });

  it('leaves a durable executing request when no result is applied after submission', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-crash-boundary');

    const stored = await environment.repositories.receiveOperationRepository.getById(
      begun.operation.id,
    );
    expect(stored).toEqual(begun.operation);
    expect(
      await environment.repositories.proofRepository.getProofsByOperationId(
        mintUrl,
        begun.operation.id,
      ),
    ).toEqual([]);
  });

  it('has one committing result across duplicate applications and ignores later proof state', async () => {
    const environment = await setup();
    const { begun } = await prepareAndBegin(environment, 'receive-duplicate');
    const secret = getSecretsFromSerializedOutputData(begun.operation.outputData).keepSecrets[0]!;
    const proof = receivedProof(secret, begun.operation.id);
    const apply = () =>
      environment.transactions.applyResult({
        operationId: begun.operation.id,
        expectedRevision: begun.operation.revision ?? 0,
        updatedAt: 400,
        proofs: [proof],
      });

    const results = await Promise.all([apply(), apply()]);
    expect(results.filter((result) => result.committed)).toHaveLength(1);
    expect(
      await environment.repositories.proofRepository.getProofsBySecrets(mintUrl, [secret]),
    ).toHaveLength(1);

    await environment.repositories.proofRepository.setProofState(mintUrl, [secret], 'inflight');
    const duplicate = await apply();
    expect(duplicate.committed).toBe(false);
    expect(duplicate.savedProofs).toEqual([]);
    expect(
      (await environment.repositories.proofRepository.getProofBySecret(mintUrl, secret))?.state,
    ).toBe('inflight');
  });
});
