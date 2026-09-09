import { RepositoryMintCommands } from '../../transactions/scoped/mint/ScopedMintCommands.ts';
import { describe, expect, it } from 'bun:test';
import { RepositoryTransactionConflictError } from '../../repositories/RepositoryTransactionError.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { CoreKeyRingTransactions } from '../../transactions/keypairs/KeyRingTransactions.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { RepositoryKeypairCommands } from '../../transactions/scoped/keypairs/ScopedKeypairCommands.ts';
import { overrideTransactions } from '../overrideTransactions.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function importedKey(publicKeyHex: string) {
  return { publicKeyHex, secretKey: new Uint8Array(32), purpose: 'p2pk' as const };
}

// Compile-time contract: neither the shared commands nor repository scope grants an opener.
function scopedAuthority(transaction: CoreTransaction, scope: RepositoryTransactionScope) {
  // @ts-expect-error No raw transaction runner on domain scope.
  transaction.run;
  // @ts-expect-error Shared commands cannot independently start a transaction.
  transaction.keypairs.withTransaction;
  // @ts-expect-error The scoped repository container deliberately omits withTransaction.
  scope.withTransaction;
}

describe('RepositoryCoreTransactionRunner', () => {
  it('reuses keypair commands through a standalone gateway and a composed transition', async () => {
    const repositories = new MemoryRepositories();
    let opens = 0;
    const runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) => {
        opens++;
        return repositories.withTransaction(work);
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

  it('binds inherited getters and frozen repository methods to the owning lifetime', async () => {
    const repositories = new MemoryRepositories();
    let boundRepositories!: RepositoryTransactionScope;
    const runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) =>
        repositories.withTransaction((scope) => {
          const { keyRingRepository, ...otherRepositories } = scope;
          // Own methods on frozen objects require the wrapper to use a separate proxy target.
          Object.freeze(
            Object.assign(keyRingRepository, {
              getLastAllocatedIndex: keyRingRepository.getLastAllocatedIndex,
              setLastAllocatedIndex: keyRingRepository.setLastAllocatedIndex,
            }),
          );
          class GetterScope {
            #keyRingRepository = keyRingRepository;

            get keyRingRepository() {
              return this.#keyRingRepository;
            }
          }
          return work(Object.assign(new GetterScope(), otherRepositories));
        }),
      ),
      (scope) => {
        boundRepositories = scope;
        return Object.freeze({
          keypairs: new RepositoryKeypairCommands(scope.keyRingRepository),
          mints: new RepositoryMintCommands(scope),
        });
      },
    );
    const input = await new KeypairDerivation(async () => new Uint8Array(64)).prepare('p2pk');
    const allocated = await new CoreKeyRingTransactions(runner).allocate(input);

    expect(allocated.derivationIndex).toBe(0);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      allocated,
    ]);
    expect(boundRepositories.keyRingRepository).toBe(boundRepositories.keyRingRepository);
    await expect(
      boundRepositories.keyRingRepository.setLastAllocatedIndex('p2pk', 99),
    ).rejects.toThrow('Wallet transaction scope is closed');
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(0);
  });

  it('retries transient repository conflicts and commits only the successful attempt', async () => {
    const repositories = new MemoryRepositories();
    let attempts = 0;
    const conflictingRepositories = overrideTransactions(
      repositories,
      async <T>(work: (scope: RepositoryTransactionScope) => Promise<T>) =>
        repositories.withTransaction(async (scope) => {
          attempts++;
          const result = await work(scope);
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

  it('yields between attempts so a competing writer can release its transaction', async () => {
    const repositories = new MemoryRepositories();
    let busy = true;
    let attempts = 0;
    const runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, async (work) => {
        attempts++;
        if (busy) {
          if (attempts === 1)
            setTimeout(() => {
              busy = false;
            }, 0);
          throw new RepositoryTransactionConflictError();
        }
        return repositories.withTransaction(work);
      }),
    );

    expect(await runner.run(async () => 'committed')).toBe('committed');
    expect(attempts).toBe(2);
  });

  it('surfaces a persistent conflict after the bounded retry budget', async () => {
    const repositories = new MemoryRepositories();
    const conflict = new RepositoryTransactionConflictError();
    let attempts = 0;
    const runner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, async () => {
        attempts++;
        throw conflict;
      }),
    );

    await expect(runner.run(async () => 'unreachable')).rejects.toBe(conflict);
    expect(attempts).toBe(3);
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

  it.each(['rollback', 'retry'] as const)(
    'drains executing repository calls before %s even when concurrency is inside a command',
    async (outcome) => {
      const repositories = new MemoryRepositories();
      const blocked = gate();
      const failed = gate();
      const failure =
        outcome === 'retry'
          ? new RepositoryTransactionConflictError('retry after draining')
          : new Error('sibling failed');
      let attempts = 0;
      let ended = 0;
      let writesFinished = 0;
      const controlled = overrideTransactions(repositories, async (work) => {
        attempts++;
        try {
          return await repositories.withTransaction((scope) => {
            if (attempts === 1) {
              const save = scope.keyRingRepository.setPersistedKeyPair.bind(
                scope.keyRingRepository,
              );
              scope.keyRingRepository.setPersistedKeyPair = async (keypair) => {
                await blocked.promise;
                await save(keypair);
                writesFinished++;
              };
              scope.counterRepository.setCounter = async () => {
                failed.release();
                throw failure;
              };
            }
            return work(scope);
          });
        } finally {
          ended++;
        }
      });
      const runner = new RepositoryCoreTransactionRunner(controlled, (scope) => {
        const keypairs = new RepositoryKeypairCommands(scope.keyRingRepository);
        // Both calls are made inside a command; tracking its returned promise alone is insufficient.
        keypairs.importP2pk = async (keypair) => {
          await Promise.all([
            scope.keyRingRepository.setPersistedKeyPair(keypair),
            scope.counterRepository.setCounter('https://mint.test', 'keyset', 7),
          ]);
        };
        return { keypairs, mints: new RepositoryMintCommands(scope) };
      });
      const result = runner
        .run((scope) => scope.keypairs.importP2pk(importedKey('slow')))
        .then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );

      try {
        await failed.promise;
        // Give an incorrectly early rollback a full turn to settle while the write is still held.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(ended).toBe(0);
        expect(attempts).toBe(1);
      } finally {
        blocked.release();
      }
      expect(await result).toEqual(
        outcome === 'retry' ? { ok: true } : { ok: false, error: failure },
      );
      expect(writesFinished).toBe(1);
      expect(attempts).toBe(outcome === 'retry' ? 2 : 1);
      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(
        outcome === 'retry' ? 1 : 0,
      );
      expect(
        await repositories.counterRepository.getCounter('https://mint.test', 'keyset'),
      ).toEqual(
        outcome === 'retry'
          ? { mintUrl: 'https://mint.test', keysetId: 'keyset', counter: 7 }
          : null,
      );
    },
  );

  it('drains started commands before committing when the callback returns early', async () => {
    const repositories = new MemoryRepositories();
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const input = await new KeypairDerivation(async () => new Uint8Array(64)).prepare(
      'nut20_mint_quote',
    );
    const pending: Promise<unknown>[] = [];

    await runner.run(async (scope) => {
      // The runner owns commands already started, even if the caller omits its aggregate await.
      pending.push(
        scope.keypairs.allocate(input),
        scope.keypairs.importP2pk(importedKey('independent')),
      );
    });

    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(1);
    expect(
      await repositories.keyRingRepository.getAllPersistedKeyPairs('nut20_mint_quote'),
    ).toHaveLength(1);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('nut20_mint_quote')).toBe(0);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'fulfilled'),
    ).toBe(true);
  });

  it.each(['catch', 'allSettled', 'unobserved'] as const)(
    'rolls back a command failure even when it is handled with %s',
    async (handling) => {
      const repositories = new MemoryRepositories();
      const runner = new RepositoryCoreTransactionRunner(repositories);
      const failure = new Error('derivation failed');

      await expect(
        runner.run(async (scope) => {
          await scope.keypairs.importP2pk(importedKey('first'));
          const allocation = scope.keypairs.allocate({
            purpose: 'p2pk',
            derive() {
              throw failure;
            },
          });
          if (handling === 'catch') await allocation.catch(() => {});
          if (handling === 'allSettled') await Promise.allSettled([allocation]);
          return 'callback succeeded';
        }),
      ).rejects.toBe(failure);

      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(0);
      expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
    },
  );

  it.each(['commit', 'rollback'] as const)(
    'revokes commands and repositories after %s',
    async (outcome) => {
      const repositories = new MemoryRepositories();
      let capturedTransaction!: CoreTransaction;
      let capturedRepositories!: RepositoryTransactionScope;
      let importKey!: CoreTransaction['keypairs']['importP2pk'];
      let persistKey!: RepositoryTransactionScope['keyRingRepository']['setPersistedKeyPair'];
      const runner = new RepositoryCoreTransactionRunner(repositories, (scope) => {
        capturedRepositories = scope;
        return {
          keypairs: new RepositoryKeypairCommands(scope.keyRingRepository),
          mints: new RepositoryMintCommands(scope),
        };
      });
      const result = runner.run(async (scope) => {
        capturedTransaction = scope;
        importKey = scope.keypairs.importP2pk;
        persistKey = capturedRepositories.keyRingRepository.setPersistedKeyPair;
        if (outcome === 'rollback') throw new Error('abort');
      });
      if (outcome === 'rollback') await expect(result).rejects.toThrow('abort');
      else await result;

      await expect(capturedTransaction.keypairs.importP2pk(importedKey('late'))).rejects.toThrow(
        'Wallet transaction scope is closed',
      );
      await expect(
        capturedRepositories.keyRingRepository.setPersistedKeyPair(importedKey('late')),
      ).rejects.toThrow('Wallet transaction scope is closed');
      await expect(importKey(importedKey('late'))).rejects.toThrow(
        'Wallet transaction scope is closed',
      );
      await expect(persistKey(importedKey('late'))).rejects.toThrow(
        'Wallet transaction scope is closed',
      );
      expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(0);
    },
  );

  it('preserves an undefined rejection reason and rolls back earlier writes', async () => {
    const repositories = new MemoryRepositories();
    const runner = new RepositoryCoreTransactionRunner(repositories);
    const result = await runner
      .run(async (scope) => {
        await scope.keypairs.importP2pk(importedKey('first'));
        throw undefined;
      })
      .then(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error }),
      );

    expect(result).toEqual({ ok: false, error: undefined });
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(0);
  });
});
