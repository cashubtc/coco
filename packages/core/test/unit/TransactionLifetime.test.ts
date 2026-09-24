import { describe, expect, it } from 'bun:test';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { TransactionLifetime } from '../../transactions/TransactionLifetime.ts';
import { RepositoryTransactionKeypairs } from '../../transactions/keypairs/TransactionKeypairs.ts';

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
  it('does not expose Object.prototype.valueOf on scoped capabilities', async () => {
    const lifetime = new TransactionLifetime();
    const scope = lifetime.bind({ keypairs: { repository: {} } });

    await lifetime.run(async () => {
      expect(Reflect.get(scope, 'valueOf')).toBeUndefined();
      expect(Reflect.get(scope.keypairs, 'valueOf')).toBeUndefined();
      expect(Reflect.get(scope.keypairs.repository, 'valueOf')).toBeUndefined();
    });
  });

  it('binds frozen capabilities and inherited repository getters without changing their receiver', async () => {
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
      const capabilities = lifetime.bind(
        Object.freeze({ keypairs: new RepositoryTransactionKeypairs(bound.keyRingRepository) }),
      );
      return lifetime.run(() => capabilities.keypairs.importP2pk(importedKey('frozen')));
    });
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      importedKey('frozen'),
    ]);
  });

  it('drains repository calls inside a failed capability and rejects further calls before rollback', async () => {
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
        // Tracking only the capability promise would miss the write still running after rejection.
        const capabilities = lifetime.bind({
          keypairs: {
            async importP2pk() {
              await Promise.all([
                bound.keyRingRepository.setPersistedKeyPair(importedKey('slow')),
                bound.counterRepository.setCounter('https://mint.test', 'keyset', 7),
              ]);
            },
          },
        });
        return lifetime.run(() => capabilities.keypairs.importP2pk());
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

  it('recursively binds a nested Mint Swap capability and drains omitted calls', async () => {
    const repositories = new MemoryRepositories();
    type NestedCapability = {
      mintSwap: {
        operationRepository: {
          persist(): Promise<void>;
        };
      };
    };
    let capturedRepository!: NestedCapability['mintSwap']['operationRepository'];
    let capturedMethod!: () => Promise<void>;

    await repositories.withTransaction((scope) => {
      const lifetime = new TransactionLifetime();
      const boundScope = lifetime.bind(scope);
      const capability = lifetime.bind(
        Object.freeze({
          mintSwap: Object.freeze({
            operationRepository: Object.freeze({
              persist: () =>
                boundScope.counterRepository.setCounter('https://source.test', 'swap', 1),
            }),
          }),
        }),
      );

      return lifetime.run(async () => {
        capturedRepository = capability.mintSwap.operationRepository;
        capturedMethod = capturedRepository.persist;
        expect(capability.mintSwap).toBe(capability.mintSwap);
        expect(capability.mintSwap.operationRepository).toBe(capturedRepository);
        expect(capturedRepository.persist).toBe(capturedMethod);
        void capturedMethod();
      });
    });

    expect(await repositories.counterRepository.getCounter('https://source.test', 'swap')).toEqual({
      mintUrl: 'https://source.test',
      keysetId: 'swap',
      counter: 1,
    });
    await expect(capturedRepository.persist()).rejects.toThrow(
      'Wallet transaction scope is closed',
    );
    await expect(capturedMethod()).rejects.toThrow('Wallet transaction scope is closed');
  });

  it('lets a caught nested capability failure poison the transaction attempt', async () => {
    const repositories = new MemoryRepositories();
    const failure = new Error('nested Mint Swap persistence failed');
    type NestedCapability = {
      mintSwap: { operationRepository: { fail(): Promise<void> } };
    };
    let captured!: NestedCapability['mintSwap']['operationRepository'];

    const result = repositories.withTransaction((scope) => {
      const lifetime = new TransactionLifetime();
      const boundScope = lifetime.bind(scope);
      const capability = lifetime.bind({
        mintSwap: {
          operationRepository: {
            async fail() {
              await boundScope.counterRepository.setCounter('https://source.test', 'swap', 1);
              throw failure;
            },
          },
        },
      });

      return lifetime.run(async () => {
        captured = capability.mintSwap.operationRepository;
        await capability.mintSwap.operationRepository.fail().catch(() => {});
      });
    });

    await expect(result).rejects.toBe(failure);
    expect(
      await repositories.counterRepository.getCounter('https://source.test', 'swap'),
    ).toBeNull();
    await expect(captured.fail()).rejects.toThrow('Wallet transaction scope is closed');
  });
});
