import { describe, expect, it } from 'bun:test';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { CoreKeyRingTransactions } from '../../transactions/keypairs/KeyRingTransactions.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';

// Compile-time contract: neither the shared commands nor repository scope grants an opener.
function scopedAuthority(transaction: CoreTransaction, scope: RepositoryTransactionScope) {
  // @ts-expect-error No raw transaction runner on domain scope.
  transaction.run;
  // @ts-expect-error Shared commands cannot independently start a transaction.
  transaction.keypairs.withTransaction;
  // @ts-expect-error The scoped repository container deliberately omits withTransaction.
  scope.withTransaction;
}

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
  it('reuses keypair commands through a standalone gateway and a composed transition', async () => {
    const repositories = new MemoryRepositories();
    let opens = 0;
    const runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (command) => {
        opens++;
        return repositories.withTransaction(command);
      }),
    );
    const derivation = new KeypairDerivation(async () => new Uint8Array(64));
    const p2pk = await derivation.prepare('p2pk');
    const quoteKey = await derivation.prepare('nut20_mint_quote');
    const gateway = new CoreKeyRingTransactions(runner);

    const first = await gateway.allocate(p2pk);
    expect(opens).toBe(1);
    const composed = await runner.run(async (transaction) => {
      const second = await transaction.keypairs.allocate(p2pk);
      const third = await transaction.keypairs.allocate(quoteKey);
      return [second, third];
    });
    expect(opens).toBe(2);
    expect(first.derivationIndex).toBe(0);
    expect(composed.map((key) => key!.derivationIndex)).toEqual([1, 0]);
  });

  it('rolls back all composed key allocations and their high-water marks on failure', async () => {
    const repositories = new MemoryRepositories();
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const derivation = new KeypairDerivation(async () => new Uint8Array(64));
    const p2pk = await derivation.prepare('p2pk');
    const quoteKey = await derivation.prepare('nut20_mint_quote');
    await expect(
      runner.run(async (transaction) => {
        await transaction.keypairs.allocate(p2pk);
        await transaction.keypairs.allocate(quoteKey);
        throw new Error('owning transition failed');
      }),
    ).rejects.toThrow('owning transition failed');
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(
      await repositories.keyRingRepository.getAllPersistedKeyPairs('nut20_mint_quote'),
    ).toEqual([]);
    const gateway = new CoreKeyRingTransactions(runner);
    expect((await gateway.allocate(p2pk)).derivationIndex).toBe(0);
    expect((await gateway.allocate(quoteKey)).derivationIndex).toBe(0);
  });

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
