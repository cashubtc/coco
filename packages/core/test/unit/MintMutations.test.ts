import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { UnknownMintError } from '../../models/Error.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreMintTransactions } from '../../transactions/mints/MintTransactions.ts';
import {
  createMintMetadataRemoteDouble,
  createMintServiceForMetadata,
} from '../fixtures/MintMetadataRefresh.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';
import { overrideTransactions } from '../overrideTransactions.ts';

const mintUrl = 'https://mint.test';
const keyset = {
  mintUrl,
  id: testMintKeysetId(),
  unit: 'sat',
  keypairs: testMintKeypairs,
  active: true,
  feePpk: 0,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.each(['memory', 'sqlite'] as const)('Mint mutations (%s)', (adapter) => {
  let repositories: Repositories;
  let database: Database | undefined;
  let events: EventBus<CoreEvents>;
  let remote: ReturnType<typeof createMintMetadataRemoteDouble>;
  let service: ReturnType<typeof createMintServiceForMetadata>;
  let transactions: CoreMintTransactions;
  let transactionOpen: boolean;
  let transactionCount: number;
  let now: number;
  let failWrite: ((scope: RepositoryTransactionScope) => void) | undefined;

  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else {
      repositories = new MemoryRepositories();
    }
    await repositories.init();
    now = Math.floor(Date.now() / 1000);
    failWrite = undefined;
    transactionOpen = false;
    transactionCount = 0;
    const controlled = overrideTransactions(repositories, (work) =>
      repositories.withTransaction(async (scope) => {
        transactionCount++;
        transactionOpen = true;
        try {
          failWrite?.(scope);
          return await work(scope);
        } finally {
          transactionOpen = false;
        }
      }),
    );
    events = new EventBus<CoreEvents>();
    remote = createMintMetadataRemoteDouble();
    remote.fetchMintMetadata.mockImplementation(async () => {
      expect(transactionOpen).toBe(false);
      return observation();
    });
    service = createMintServiceForMetadata(controlled, remote, events);
    transactions = new CoreMintTransactions(new RepositoryCoreTransactionRunner(controlled));
  });

  afterEach(() => database?.close());

  function observation() {
    return {
      mintUrl,
      mintInfo: { ...testMintInfo, name: 'Refreshed' },
      keysets: [{ ...keyset, active: false }],
      observedAt: now,
    };
  }

  async function seed(trusted = true, updatedAt = now) {
    await repositories.mintRepository.addNewMint({
      mintUrl,
      name: 'Local name',
      trusted,
      mintInfo: testMintInfo,
      createdAt: 1,
      updatedAt,
    });
    await repositories.keysetRepository.addKeyset(keyset);
  }

  function recordEvents() {
    const published: string[] = [];
    for (const event of [
      'mint:added',
      'mint:updated',
      'mint:trusted',
      'mint:untrusted',
      'mint:metadata-refreshed',
    ] as const) {
      events.on(event, () => {
        expect(transactionOpen).toBe(false);
        published.push(event);
      });
    }
    return published;
  }

  it('atomically adds metadata, keys, and explicit trust before publishing', async () => {
    const published = recordEvents();
    events.on('mint:metadata-refreshed', async () => {
      expect(await service.isTrustedMint(mintUrl)).toBe(true);
      expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toHaveLength(1);
    });
    const result = await service.addMintByUrl(`${mintUrl}/`, { trusted: true });
    expect(result.mint.trusted).toBe(true);
    expect(transactionCount).toBe(1);
    expect(published).toEqual(['mint:metadata-refreshed', 'mint:added']);
    expect(remote.fetchMintMetadata).toHaveBeenCalledWith(mintUrl, []);
  });

  it('uses fresh stored metadata while applying explicit trust changes in one transaction', async () => {
    await seed();
    const published = recordEvents();
    const result = await service.addMintByUrl(mintUrl, { trusted: false });
    expect(result.mint.trusted).toBe(false);
    expect(result.mint.createdAt).toBe(1);
    expect(remote.fetchMintMetadata).not.toHaveBeenCalled();
    expect(transactionCount).toBe(1);
    expect(published).toEqual(['mint:untrusted', 'mint:updated']);
    expect((await service.addMintByUrl(mintUrl)).mint.trusted).toBe(false);
  });

  it('does not recreate a concurrently deleted mint from cached metadata', async () => {
    await seed();
    await service.deleteMint(mintUrl);
    await expect(transactions.add({ mintUrl, trusted: true })).rejects.toBeInstanceOf(
      UnknownMintError,
    );
    expect(await service.getAllMints()).toEqual([]);
  });

  it('forced refresh fetches fresh metadata and applies changes in the same timestamp second', async () => {
    await seed();
    const published = recordEvents();
    const result = await service.updateMintData(`${mintUrl}/`);
    expect(remote.fetchMintMetadata).toHaveBeenCalledWith(mintUrl, [
      expect.objectContaining(keyset),
    ]);
    expect(result.mint.mintInfo.name).toBe('Refreshed');
    expect(result.mint.updatedAt).toBe(now);
    expect(result.mint.name).toBe('Local name');
    expect(result.mint.createdAt).toBe(1);
    expect(result.keysets[0]?.active).toBe(false);
    expect(transactionCount).toBe(1);
    expect(published).toEqual(['mint:metadata-refreshed']);
  });

  it('does not replace a newer committed snapshot with an older forced observation', async () => {
    await seed(true, now + 1);
    const published = recordEvents();
    const result = await service.updateMintData(mintUrl);
    expect(result.mint.mintInfo).toEqual(testMintInfo);
    expect(result.keysets[0]?.active).toBe(true);
    expect(published).toEqual([]);
  });

  it.each(['add', 'force'] as const)(
    'preserves a trust change committed during %s remote preflight',
    async (action) => {
      await seed(true, action === 'add' ? 0 : now);
      const started = deferred();
      const resume = deferred();
      remote.fetchMintMetadata.mockImplementation(async () => {
        expect(transactionOpen).toBe(false);
        started.resolve();
        await resume.promise;
        return observation();
      });
      const pending =
        action === 'add' ? service.addMintByUrl(mintUrl) : service.updateMintData(mintUrl);
      await started.promise;
      try {
        const otherSession = new CoreMintTransactions(
          new RepositoryCoreTransactionRunner(repositories),
        );
        await otherSession.setTrusted({ mintUrl, trusted: false });
      } finally {
        resume.resolve();
      }
      expect((await pending).mint.trusted).toBe(false);
      expect(await service.isTrustedMint(mintUrl)).toBe(false);
    },
  );

  it('applies explicit add trust even when a newer observation wins during its fetch', async () => {
    await seed(false, 0);
    remote.fetchMintMetadata.mockImplementation(async () => {
      await transactions.applyObservation({ ...observation(), observedAt: now + 1 });
      return observation();
    });
    const published = recordEvents();
    const result = await service.addMintByUrl(mintUrl, { trusted: true });
    expect(result.mint.trusted).toBe(true);
    expect(result.mint.updatedAt).toBe(now + 1);
    expect(published).toEqual(['mint:trusted', 'mint:updated']);
  });

  it('reports creation from committed state when another add wins during the fetch', async () => {
    remote.fetchMintMetadata.mockImplementation(async () => {
      await transactions.add({ mintUrl, observation: observation(), trusted: true });
      return observation();
    });
    const published = recordEvents();
    const result = await service.addMintByUrl(mintUrl);
    expect(result.mint.trusted).toBe(true);
    expect(published).toEqual([]);
  });

  it.each(['add', 'force'] as const)(
    'leaves no writes or events when %s remote fetching fails',
    async (action) => {
      const published = recordEvents();
      remote.fetchMintMetadata.mockRejectedValue(new Error('fetch failed'));
      const pending =
        action === 'add' ? service.addMintByUrl(mintUrl) : service.updateMintData(mintUrl);
      await expect(pending).rejects.toThrow('fetch failed');
      expect(transactionCount).toBe(0);
      expect(await service.getAllMints()).toEqual([]);
      expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
      expect(published).toEqual([]);
    },
  );

  it.each(['add', 'force'] as const)(
    'rolls back keys when the %s mint write fails',
    async (action) => {
      if (action === 'force') await seed();
      failWrite = (scope) => {
        scope.mintRepository.addOrUpdateMint = async () => {
          throw new Error('mint write failed');
        };
      };
      const published = recordEvents();
      const pending =
        action === 'add'
          ? service.addMintByUrl(mintUrl, { trusted: true })
          : service.updateMintData(mintUrl);
      await expect(pending).rejects.toThrow('mint write failed');
      if (action === 'add') {
        expect(await service.getAllMints()).toEqual([]);
        expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
      } else {
        expect((await repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo).toEqual(
          testMintInfo,
        );
        expect(
          (await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active,
        ).toBe(true);
      }
      expect(published).toEqual([]);
    },
  );

  it('rolls back added metadata and keys when explicit trust persistence fails', async () => {
    failWrite = (scope) => {
      scope.mintRepository.setMintTrusted = async () => {
        throw new Error('trust write failed');
      };
    };
    const published = recordEvents();
    await expect(service.addMintByUrl(mintUrl, { trusted: true })).rejects.toThrow(
      'trust write failed',
    );
    expect(await service.getAllMints()).toEqual([]);
    expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
    expect(published).toEqual([]);
  });

  it('rolls back a failed trust write without publishing a trust event', async () => {
    await seed(false);
    failWrite = (scope) => {
      const setTrusted = scope.mintRepository.setMintTrusted.bind(scope.mintRepository);
      scope.mintRepository.setMintTrusted = async (url, trusted) => {
        await setTrusted(url, trusted);
        throw new Error('trust write failed');
      };
    };
    const published = recordEvents();
    await expect(service.trustMint(mintUrl)).rejects.toThrow('trust write failed');
    expect(await service.isTrustedMint(mintUrl)).toBe(false);
    expect(remote.fetchMintMetadata).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('composes mint commands inside one caller-owned transaction and rolls them back together', async () => {
    const runner = new RepositoryCoreTransactionRunner(repositories);
    await expect(
      runner.run(async (scope) => {
        await scope.mints.add({ mintUrl, observation: observation(), trusted: true });
        await scope.mints.setTrusted({ mintUrl, trusted: false });
        throw new Error('composed transition failed');
      }),
    ).rejects.toThrow('composed transition failed');
    expect(await service.getAllMints()).toEqual([]);
    expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
  });

  it('rolls back keyset deletion if deleting the mint fails', async () => {
    await seed();
    failWrite = (scope) => {
      scope.mintRepository.deleteMint = async () => {
        throw new Error('delete failed');
      };
    };
    await expect(service.deleteMint(`${mintUrl}/`)).rejects.toThrow('delete failed');
    expect(await service.isTrustedMint(mintUrl)).toBe(true);
    expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toHaveLength(1);
    failWrite = undefined;
    await service.deleteMint(mintUrl);
    expect(await service.getAllMints()).toEqual([]);
    expect(await repositories.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
    await service.deleteMint(mintUrl);
  });

  it('trust mutations commit before listeners and retain trust if a later stale refresh fails', async () => {
    await seed(false, 0);
    events.on('mint:trusted', async () => {
      expect(transactionOpen).toBe(false);
      expect(await service.isTrustedMint(mintUrl)).toBe(true);
      throw new Error('listener failed');
    });
    remote.fetchMintMetadata.mockRejectedValue(new Error('fetch failed'));
    await expect(service.trustMint(mintUrl)).rejects.toThrow('fetch failed');
    expect(await service.isTrustedMint(mintUrl)).toBe(true);
    expect(transactionCount).toBe(1);
  });

  it.each(['add', 'force', 'trust', 'untrust'] as const)(
    'retains the %s commit and attempts remaining events after listener failures',
    async (action) => {
      if (action !== 'add') await seed(action === 'untrust');
      const updated = mock(() => {
        throw new Error('updated listener failed');
      });
      const added = mock(() => {
        throw new Error('added listener failed');
      });
      for (const event of ['mint:metadata-refreshed', 'mint:trusted', 'mint:untrusted'] as const) {
        events.on(event, () => {
          throw new Error('listener failed');
        });
      }
      events.on('mint:added', added);
      events.on('mint:updated', updated);
      if (action === 'add') {
        await service.addMintByUrl(mintUrl, { trusted: true });
        expect(added).toHaveBeenCalledTimes(1);
      } else if (action === 'force') {
        await service.updateMintData(mintUrl);
        expect((await repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
          'Refreshed',
        );
      } else {
        await (action === 'trust' ? service.trustMint(mintUrl) : service.untrustMint(mintUrl));
        expect(await service.isTrustedMint(mintUrl)).toBe(action === 'trust');
        expect(updated).toHaveBeenCalledTimes(1);
      }
      expect(transactionCount).toBe(1);
    },
  );
});
