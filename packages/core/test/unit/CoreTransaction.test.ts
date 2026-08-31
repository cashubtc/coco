import { describe, expect, it } from 'bun:test';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';

function overrideTransactions(
  base: Repositories,
  withTransaction: Repositories['withTransaction'],
): Repositories {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'withTransaction') return withTransaction;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('RepositoryCoreTransactionRunner', () => {
  it('retries transient repository conflicts and commits only the successful attempt', async () => {
    const repositories = new MemoryRepositories();
    let attempts = 0;
    const conflictingRepositories = overrideTransactions(
      repositories,
      async <T>(command: (scope: RepositoryTransactionScope) => Promise<T>) =>
        repositories.withTransaction(async (scope) => {
          attempts++;
          const result = await command(scope);
          if (attempts < 3) {
            throw new RepositoryTransactionConflictError('transient conflict');
          }
          return result;
        }),
    );
    const runner = new RepositoryCoreTransactionRunner(conflictingRepositories);

    const allocated = await runner.run((transaction) =>
      transaction.keypairs.allocate({
        purpose: 'p2pk',
        derive: (derivationIndex) => ({
          publicKeyHex: `key-${derivationIndex}`,
          secretKey: new Uint8Array(32).fill(derivationIndex + 1),
        }),
      }),
    );

    expect(attempts).toBe(3);
    expect(allocated.derivationIndex).toBe(0);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      allocated,
    ]);
  });

  it('does not retry domain failures', async () => {
    const repositories = new MemoryRepositories();
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const invariantError = new Error('invalid key allocation');
    let attempts = 0;

    await expect(
      runner.run(async () => {
        attempts++;
        throw invariantError;
      }),
    ).rejects.toBe(invariantError);

    expect(attempts).toBe(1);
  });
});
