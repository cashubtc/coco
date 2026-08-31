import { Amount, type MintKeys, type OutputDataLike, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { createReceiveOperation } from '../../operations/receive/ReceiveOperation.ts';
import type { ReceiveOperationRepository, RepositoryTransactionScope } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
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
