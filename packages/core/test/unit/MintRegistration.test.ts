import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { MintService } from '../../services/MintService.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreMintTransactions } from '../../transactions/mints/MintTransactions.ts';
import { RepositoryKeypairCommands } from '../../transactions/scoped/keypairs/ScopedKeypairCommands.ts';
import { RepositoryMintCommands } from '../../transactions/scoped/mints/ScopedMintCommands.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';

const mintUrl = 'https://mint.example.com';
const databases: Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapter() {
  return {
    fetchMintInfo: mock(async () => ({ name: 'Mint', nuts: {} })),
    fetchKeysets: mock(async () => ({
      keysets: [{ id: '00test', unit: 'sat', active: true, input_fee_ppk: 0 }],
    })),
    fetchKeysForId: mock(async () => ({ '1': 'key' })),
  };
}

function service(
  repositories: Repositories,
  remote = adapter(),
  events = new EventBus<CoreEvents>(),
  runner = new RepositoryCoreTransactionRunner(repositories),
) {
  return new MintService(
    repositories.mintRepository,
    repositories.keysetRepository,
    remote as unknown as MintAdapter,
    new CoreMintTransactions(runner),
    undefined,
    events,
  );
}

for (const storage of ['memory', 'sqlite'] as const) {
  describe(`Known Mint registration with ${storage}`, () => {
    async function repositories(): Promise<Repositories> {
      if (storage === 'memory') return new MemoryRepositories();
      const database = new Database(':memory:');
      databases.push(database);
      const result = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      await result.init();
      return result;
    }

    it('reports exactly one creation across independent coordinators', async () => {
      const repos = await repositories();
      const entered = deferred();
      const proceed = deferred();
      const remote = adapter();
      let calls = 0;
      remote.fetchMintInfo.mockImplementation(async () => {
        if (++calls === 2) entered.resolve();
        await proceed.promise;
        return { name: 'Mint', nuts: {} };
      });
      const first = service(repos, remote).addMintByUrl(mintUrl + '/');
      const second = service(repos, remote).addMintByUrl(mintUrl);
      await entered.promise;
      proceed.resolve();
      const results = await Promise.all([first, second]);
      expect(results.map((result) => result.created).sort()).toEqual([false, true]);
      expect(await repos.mintRepository.getAllMints()).toHaveLength(1);
      expect(await repos.keysetRepository.getKeysetsByMintUrl(mintUrl)).toHaveLength(1);
      expect(results.every((result) => result.mint.trusted === false)).toBe(true);
    });

    it('reports creation if a stale Known Mint is deleted during discovery', async () => {
      const repos = await repositories();
      const initial = await service(repos).addMintByUrl(mintUrl);
      await repos.mintRepository.updateMint({ ...initial.mint, updatedAt: 0 });
      const entered = deferred();
      const proceed = deferred();
      const remote = adapter();
      remote.fetchMintInfo.mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        return { name: 'Mint', nuts: {} };
      });
      const registration = service(repos, remote).addMintByUrl(mintUrl);
      await entered.promise;
      await new CoreMintTransactions(new RepositoryCoreTransactionRunner(repos)).delete(mintUrl);
      proceed.resolve();
      expect((await registration).created).toBe(true);
    });

    it('preserves trust changed while metadata is fetched remotely', async () => {
      const repos = await repositories();
      const initial = await service(repos).addMintByUrl(mintUrl, { trusted: true });
      const entered = deferred();
      const proceed = deferred();
      const remote = adapter();
      remote.fetchMintInfo.mockImplementation(async () => {
        entered.resolve();
        await proceed.promise;
        return { name: 'New metadata', nuts: {} };
      });
      const refresh = service(repos, remote).updateMintData(mintUrl);
      await entered.promise;
      await new CoreMintTransactions(new RepositoryCoreTransactionRunner(repos)).setTrust({
        mintUrl,
        trusted: false,
      });
      proceed.resolve();
      const result = await refresh;
      expect(result.mint.trusted).toBe(false);
      expect(result.mint.createdAt).toBe(initial.mint.createdAt);
      expect((await repos.mintRepository.getMintByUrl(mintUrl)).trusted).toBe(false);
    });

    it('rolls back mint metadata and every keyset when a scoped write fails', async () => {
      const repos = await repositories();
      const events = new EventBus<CoreEvents>();
      const emitted = mock(() => {});
      events.on('mint:added', emitted);
      events.on('mint:metadata-refreshed', emitted);
      const failure = new Error('keyset persistence failed');
      const runner = new RepositoryCoreTransactionRunner(repos, (scope) => ({
        keypairs: new RepositoryKeypairCommands(scope.keyRingRepository),
        mints: new RepositoryMintCommands(scope.mintRepository, {
          getKeysetById: (url, id) => scope.keysetRepository.getKeysetById(url, id),
          getKeysetsByMintUrl: (url) => scope.keysetRepository.getKeysetsByMintUrl(url),
          updateKeyset: (keyset) => scope.keysetRepository.updateKeyset(keyset),
          deleteKeyset: (url, id) => scope.keysetRepository.deleteKeyset(url, id),
          addKeyset: async (keyset) => {
            await scope.keysetRepository.addKeyset(keyset);
            throw failure;
          },
        }),
      }));
      await expect(service(repos, adapter(), events, runner).addMintByUrl(mintUrl)).rejects.toBe(
        failure,
      );
      expect(await repos.mintRepository.getAllMints()).toEqual([]);
      expect(await repos.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
      expect(emitted).not.toHaveBeenCalled();
    });

    it('does not persist partial discovery if a later keyset cannot be fetched', async () => {
      const repos = await repositories();
      const remote = adapter();
      remote.fetchKeysets.mockImplementation(async () => ({
        keysets: [
          { id: '00first', unit: 'sat', active: true, input_fee_ppk: 0 },
          { id: '00second', unit: 'sat', active: true, input_fee_ppk: 0 },
        ],
      }));
      let calls = 0;
      remote.fetchKeysForId.mockImplementation(async () => {
        if (++calls === 2) throw new Error('unreachable keys');
        return { '1': 'key' };
      });
      await expect(service(repos, remote).addMintByUrl(mintUrl)).rejects.toThrow();
      expect(await repos.mintRepository.getAllMints()).toEqual([]);
      expect(await repos.keysetRepository.getKeysetsByMintUrl(mintUrl)).toEqual([]);
    });

    it('returns the committed registration even if an event listener rejects', async () => {
      const repos = await repositories();
      const events = new EventBus<CoreEvents>({ throwOnError: true });
      events.on('mint:metadata-refreshed', () => {
        throw new Error('observer failed');
      });
      events.on('mint:added', () => {
        throw new Error('observer failed');
      });
      const result = await service(repos, adapter(), events).addMintByUrl(mintUrl);
      expect(result.created).toBe(true);
      expect((await repos.mintRepository.getMintByUrl(mintUrl)).mintUrl).toBe(mintUrl);
    });

    it('publishes metadata only after mint and keysets are visible outside the transaction', async () => {
      const repos = await repositories();
      const events = new EventBus<CoreEvents>();
      const observed: string[] = [];
      events.on('mint:metadata-refreshed', async () => {
        const mint = await repos.mintRepository.getMintByUrl(mintUrl);
        const keys = await repos.keysetRepository.getKeysetsByMintUrl(mintUrl);
        observed.push(`${mint.mintUrl}:${keys.length}`);
      });
      await service(repos, adapter(), events).addMintByUrl(mintUrl);
      expect(observed).toEqual([`${mintUrl}:1`]);
    });
  });
}
