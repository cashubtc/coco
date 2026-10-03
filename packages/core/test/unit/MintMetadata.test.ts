import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { MintAdapter } from '../../infra/MintAdapter.ts';
import { MintRequestProvider } from '../../infra/MintRequestProvider.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { createMintServiceForMetadata } from '../fixtures/MintMetadataRefresh.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const original = {
  mintUrl,
  name: 'Test Mint',
  trusted: true,
  mintInfo: testMintInfo,
  createdAt: 1,
  updatedAt: 10,
};
const keyset = {
  mintUrl,
  id: testMintKeysetId(),
  unit: 'sat',
  keypairs: testMintKeypairs,
  active: true,
  feePpk: 0,
};
const observation = {
  mintUrl,
  mintInfo: { ...testMintInfo, name: 'Refreshed' },
  keysets: [{ ...keyset, active: false }],
  observedAt: 20,
};

describe.each(['memory', 'sqlite'] as const)(
  'Mint metadata queries and transactions (%s)',
  (adapter) => {
    let repositories: Repositories;
    let database: Database | undefined;

    beforeEach(async () => {
      if (adapter === 'sqlite') {
        database = new Database(':memory:');
        repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      } else {
        repositories = new MemoryRepositories();
      }
      await repositories.init();
    });

    afterEach(() => database?.close());

    for (const failWrite of [false, true]) {
      it(`backfills verified keys through stale refresh (persistence failure: ${failWrite})`, async () => {
        await repositories.mintRepository.addNewMint(original);
        await repositories.keysetRepository.updateKeyset(keyset);
        let transactionOpen = false;
        const controlled = overrideTransactions(repositories, (work) =>
          repositories.withTransaction(async (scope) => {
            transactionOpen = true;
            if (failWrite) {
              scope.mintRepository.addOrUpdateMint = async () => {
                expect(
                  (await scope.keysetRepository.getKeysetById(mintUrl, keyset.id))?.keypairs,
                ).toEqual(testMintKeypairs);
                throw new Error('metadata write failed');
              };
            }
            try {
              return await work(scope);
            } finally {
              transactionOpen = false;
            }
          }),
        );
        const requests: string[] = [];
        const provider = new MintRequestProvider();
        provider.getRequestFn =
          () =>
          async <T>({ endpoint }: { endpoint: string }): Promise<T> => {
            expect(transactionOpen).toBe(false);
            requests.push(endpoint);
            if (endpoint.endsWith('/v1/info')) return testMintInfo as T;
            if (endpoint.endsWith('/v1/keysets')) {
              return { keysets: [{ id: keyset.id, unit: 'sat', active: true }] } as T;
            }
            if (endpoint.endsWith(`/v1/keys/${keyset.id}`)) {
              return { keysets: [{ id: keyset.id, unit: 'sat', keys: testMintKeypairs }] } as T;
            }
            throw new Error(`Unexpected endpoint: ${endpoint}`);
          };
        const adapter = new MintAdapter(provider);
        const events = new EventBus<CoreEvents>();
        const published: unknown[] = [];
        const recordEvent = async () => {
          published.push({
            transactionOpen,
            keypairs: (await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))
              ?.keypairs,
          });
        };
        events.on('mint:metadata-refreshed', recordEvent);
        events.on('mint:updated', recordEvent);
        const service = createMintServiceForMetadata(
          controlled,
          {
            fetchMintMetadata: adapter.fetchMintMetadata.bind(adapter),
          },
          events,
        );
        if (failWrite) {
          await expect(service.refreshAndCommitIfStale(mintUrl)).rejects.toThrow(
            'metadata write failed',
          );
          expect(
            (await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.keypairs,
          ).toEqual({});
          expect(await repositories.mintRepository.getMintByUrl(mintUrl)).toEqual(original);
          expect(published).toEqual([]);
        } else {
          const result = await service.refreshAndCommitIfStale(mintUrl);
          expect(result.keysets[0]?.keypairs).toEqual(testMintKeypairs);
          expect(
            (await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.keypairs,
          ).toEqual(testMintKeypairs);
          expect(published).toEqual([
            { transactionOpen: false, keypairs: testMintKeypairs },
            { transactionOpen: false, keypairs: testMintKeypairs },
          ]);
          await service.refreshAndCommitIfStale(mintUrl);
          expect(requests).toHaveLength(3);
          await repositories.mintRepository.updateMint({ ...result.mint, updatedAt: 0 });
          expect((await service.refreshAndCommitIfStale(mintUrl)).keysets[0]?.keypairs).toEqual(
            testMintKeypairs,
          );
          expect(requests.filter((endpoint) => endpoint.includes('/v1/keys/'))).toHaveLength(1);
        }
      });
    }

    it('rejects refreshed keys that conflict with populated stored keys without publishing events', async () => {
      await repositories.mintRepository.addNewMint(original);
      await repositories.keysetRepository.addKeyset({
        ...keyset,
        keypairs: { ...testMintKeypairs, '1': testMintKeypairs['2'] },
      });
      const stored = await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id);
      const requests: string[] = [];
      const provider = new MintRequestProvider();
      provider.getRequestFn =
        () =>
        async <T>({ endpoint }: { endpoint: string }): Promise<T> => {
          requests.push(endpoint);
          if (endpoint.endsWith('/v1/info')) return observation.mintInfo as T;
          if (endpoint.endsWith('/v1/keysets')) {
            return { keysets: [{ id: keyset.id, unit: 'sat', active: false }] } as T;
          }
          if (endpoint.endsWith(`/v1/keys/${keyset.id}`)) {
            return { keysets: [{ id: keyset.id, unit: 'sat', keys: testMintKeypairs }] } as T;
          }
          throw new Error(`Unexpected endpoint: ${endpoint}`);
        };
      const mintAdapter = new MintAdapter(provider);
      const events = new EventBus<CoreEvents>();
      const published: string[] = [];
      events.on('mint:metadata-refreshed', () => {
        published.push('mint:metadata-refreshed');
      });
      events.on('mint:updated', () => {
        published.push('mint:updated');
      });
      const service = createMintServiceForMetadata(
        repositories,
        { fetchMintMetadata: mintAdapter.fetchMintMetadata.bind(mintAdapter) },
        events,
      );

      await expect(service.refreshAndCommitIfStale(mintUrl)).rejects.toMatchObject({
        name: 'KeysetKeysConflictError',
        mintUrl,
        keysetId: keyset.id,
      });
      expect(requests).toContain(`${mintUrl}/v1/keys/${keyset.id}`);
      expect(await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id)).toEqual(stored);
      expect(await repositories.mintRepository.getMintByUrl(mintUrl)).toEqual(original);
      expect(published).toEqual([]);
    });

    it('returns missing or stale stored metadata without opening a transaction or refreshing it', async () => {
      const queries = new StoredMintQueries(
        repositories.mintRepository,
        repositories.keysetRepository,
      );
      expect(await queries.getMetadata(mintUrl)).toBeNull();
      expect(await repositories.mintRepository.getAllMints()).toEqual([]);
      await repositories.mintRepository.addNewMint(original);
      await repositories.keysetRepository.addKeyset(keyset);
      const result = await queries.getMetadata(`${mintUrl}/`);
      expect(result?.mint.updatedAt).toBe(10);
      expect(result?.keysets[0]?.active).toBe(true);
    });

    it('preserves current trust when applying metadata fetched before a trust change', async () => {
      await repositories.mintRepository.addNewMint({ ...original, trusted: false });
      await repositories.keysetRepository.addKeyset(keyset);
      const transactionRunner = new RepositoryCoreTransactionRunner(repositories);
      const result = await transactionRunner.run((tx) =>
        tx.mintMetadata.applyObservation(observation),
      );
      expect(result.applied).toBe(true);
      expect(result.metadata.mint.trusted).toBe(false);
      expect(result.metadata.mint.mintInfo.name).toBe('Refreshed');
      expect(result.metadata.keysets[0]?.active).toBe(false);
    });

    it('ignores observations older than the committed mint snapshot', async () => {
      await repositories.mintRepository.addNewMint({ ...original, updatedAt: 30 });
      await repositories.keysetRepository.addKeyset(keyset);
      const transactionRunner = new RepositoryCoreTransactionRunner(repositories);
      const result = await transactionRunner.run((tx) =>
        tx.mintMetadata.applyObservation(observation),
      );
      expect(result.applied).toBe(false);
      expect(result.metadata.mint.updatedAt).toBe(30);
      expect(result.metadata.mint.mintInfo).toEqual(testMintInfo);
      expect(result.metadata.keysets[0]?.active).toBe(true);
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(30);
    });

    it('keeps the first committed snapshot when observations have equal timestamps', async () => {
      await repositories.mintRepository.addNewMint(original);
      await repositories.keysetRepository.addKeyset(keyset);
      const transactionRunner = new RepositoryCoreTransactionRunner(repositories);
      const committed = await transactionRunner.run((tx) =>
        tx.mintMetadata.applyObservation(observation),
      );
      const result = await transactionRunner.run((tx) =>
        tx.mintMetadata.applyObservation({
          ...observation,
          mintInfo: testMintInfo,
          keysets: [keyset],
        }),
      );
      expect(committed.applied).toBe(true);
      expect(result.applied).toBe(false);
      expect(result.metadata).toEqual(committed.metadata);
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
        'Refreshed',
      );
      expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
        false,
      );
    });

    it('rolls back keyset refreshes if the mint snapshot cannot be persisted', async () => {
      await repositories.mintRepository.addNewMint(original);
      await repositories.keysetRepository.addKeyset(keyset);
      const controlled = overrideTransactions(repositories, (fn) =>
        repositories.withTransaction((scope) => {
          scope.mintRepository.addOrUpdateMint = async () => {
            throw new Error('metadata write failed');
          };
          return fn(scope);
        }),
      );
      const transactionRunner = new RepositoryCoreTransactionRunner(controlled);
      await expect(
        transactionRunner.run((tx) => tx.mintMetadata.applyObservation(observation)),
      ).rejects.toThrow('metadata write failed');
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(10);
      expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
        true,
      );
    });
  },
);
