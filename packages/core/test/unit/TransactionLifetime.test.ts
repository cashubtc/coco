import { describe, expect, it } from 'bun:test';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { TransactionLifetime } from '../../transactions/scoped/TransactionLifetime.ts';
import { RepositoryKeypairCommands } from '../../transactions/scoped/keypairs/ScopedKeypairCommands.ts';

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

describe('TransactionLifetime', () => {
  it('binds frozen commands and inherited repository getters without changing their receiver', async () => {
    const repositories = new MemoryRepositories();
    const lifetime = new TransactionLifetime();
    await repositories.withTransaction((scope) => {
      const keyRingRepository = Object.freeze(
        Object.assign(scope.keyRingRepository, {
          setPersistedKeyPair: scope.keyRingRepository.setPersistedKeyPair,
        }),
      );
      class GetterScope {
        #repository = keyRingRepository;

        get keyRingRepository() {
          return this.#repository;
        }
      }
      const bound = lifetime.bind(new GetterScope());
      expect(bound.keyRingRepository).toBe(bound.keyRingRepository);
      const commands = lifetime.bind(
        Object.freeze({ keypairs: new RepositoryKeypairCommands(bound.keyRingRepository) }),
      );
      return lifetime.run(() => commands.keypairs.importP2pk(importedKey('frozen')));
    });
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      importedKey('frozen'),
    ]);
  });

  it('drains repository calls inside a failed command and rejects further calls before rollback', async () => {
    const repositories = new MemoryRepositories();
    const blocked = gate();
    const failed = gate();
    const failure = new Error('sibling failed');
    let bound!: RepositoryTransactionScope;
    let ended = false;
    let writesFinished = 0;
    const result = repositories
      .withTransaction((scope) => {
        const save = scope.keyRingRepository.setPersistedKeyPair.bind(scope.keyRingRepository);
        scope.keyRingRepository.setPersistedKeyPair = async (keypair) => {
          await blocked.promise;
          await save(keypair);
          writesFinished++;
        };
        scope.counterRepository.setCounter = async () => {
          failed.release();
          throw failure;
        };
        const lifetime = new TransactionLifetime();
        bound = lifetime.bind(scope);
        // Tracking only the command promise would miss the write still running after rejection.
        const commands = lifetime.bind({
          keypairs: {
            async importP2pk() {
              await Promise.all([
                bound.keyRingRepository.setPersistedKeyPair(importedKey('slow')),
                bound.counterRepository.setCounter('https://mint.test', 'keyset', 7),
              ]);
            },
          },
        });
        return lifetime.run(() => commands.keypairs.importP2pk());
      })
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      .finally(() => {
        ended = true;
      });

    try {
      await failed.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(ended).toBe(false);
      expect(writesFinished).toBe(0);
      await expect(bound.keyRingRepository.deletePersistedKeyPair('slow', 'p2pk')).rejects.toBe(
        failure,
      );
    } finally {
      blocked.release();
    }
    expect(await result).toEqual({ ok: false, error: failure });
    expect(writesFinished).toBe(1);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(
      await repositories.counterRepository.getCounter('https://mint.test', 'keyset'),
    ).toBeNull();
  });

  it.each(['commit', 'rollback'] as const)('revokes repositories after %s', async (outcome) => {
    const repositories = new MemoryRepositories();
    let bound!: RepositoryTransactionScope;
    let persistKey!: RepositoryTransactionScope['keyRingRepository']['setPersistedKeyPair'];
    const result = repositories.withTransaction((scope) => {
      const lifetime = new TransactionLifetime();
      bound = lifetime.bind(scope);
      persistKey = bound.keyRingRepository.setPersistedKeyPair;
      return lifetime.run(async () => {
        if (outcome === 'rollback') throw new Error('abort');
      });
    });
    if (outcome === 'rollback') await expect(result).rejects.toThrow('abort');
    else await result;

    await expect(bound.keyRingRepository.setPersistedKeyPair(importedKey('late'))).rejects.toThrow(
      'Wallet transaction scope is closed',
    );
    await expect(persistKey(importedKey('late'))).rejects.toThrow(
      'Wallet transaction scope is closed',
    );
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
  });
});
