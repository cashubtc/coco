import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreMintMetadataTransactions } from '../../transactions/mints/MintMetadataTransactions.ts';
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
      expect(await queries.isTrustedMint(`${mintUrl}/`)).toBe(true);
    });

    it('preserves current trust when applying metadata fetched before a trust change', async () => {
      await repositories.mintRepository.addNewMint({ ...original, trusted: false });
      await repositories.keysetRepository.addKeyset(keyset);
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      const result = await transactions.applyObservation(observation);
      expect(result.applied).toBe(true);
      expect(result.metadata.mint.trusted).toBe(false);
      expect(result.metadata.mint.mintInfo.name).toBe('Refreshed');
      expect(result.metadata.keysets[0]?.active).toBe(false);
    });

    it('ignores observations older than the committed mint snapshot', async () => {
      await repositories.mintRepository.addNewMint({ ...original, updatedAt: 30 });
      await repositories.keysetRepository.addKeyset(keyset);
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      const result = await transactions.applyObservation(observation);
      expect(result.applied).toBe(false);
      expect(result.metadata.mint.updatedAt).toBe(30);
      expect(result.metadata.mint.mintInfo).toEqual(testMintInfo);
      expect(result.metadata.keysets[0]?.active).toBe(true);
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(30);
    });

    it('keeps the first committed snapshot when observations have equal timestamps', async () => {
      await repositories.mintRepository.addNewMint(original);
      await repositories.keysetRepository.addKeyset(keyset);
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(repositories),
      );
      const committed = await transactions.applyObservation(observation);
      const result = await transactions.applyObservation({
        ...observation,
        mintInfo: testMintInfo,
        keysets: [keyset],
      });
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
      const transactions = new CoreMintMetadataTransactions(
        new RepositoryCoreTransactionRunner(controlled),
      );
      await expect(transactions.applyObservation(observation)).rejects.toThrow(
        'metadata write failed',
      );
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(10);
      expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
        true,
      );
    });
  },
);
