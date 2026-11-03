import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MintQuoteKeyError } from '../../models/Error.ts';
import type { Keypair } from '../../models/Keypair.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import {
  ODD_Y_CANONICAL_PUBLIC_KEY as canonicalKey,
  ODD_Y_LEGACY_PUBLIC_KEY as legacyKey,
  ODD_Y_SECRET_KEY,
} from '../fixtures/P2pkKeys.ts';

const importedKey: Keypair = {
  publicKeyHex: canonicalKey,
  secretKey: ODD_Y_SECRET_KEY,
  purpose: 'p2pk',
};
const legacyKeypair: Keypair = { ...importedKey, publicKeyHex: legacyKey, derivationIndex: 7 };

describe.each(['memory', 'sqlite'] as const)('P2PK transactions with %s', (adapter) => {
  let database: Database | undefined;
  let repositories: Repositories;
  let runner: RepositoryCoreTransactionRunner;

  beforeEach(async () => {
    if (adapter === 'sqlite') {
      database = new Database(':memory:');
      repositories = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
    } else {
      repositories = new MemoryRepositories();
    }
    await repositories.init();
    runner = new RepositoryCoreTransactionRunner(repositories);
  });

  afterEach(() => database?.close());

  it('preserves a legacy identity and metadata across concurrent reimports', async () => {
    await repositories.keyRingRepository.setPersistedKeyPair(legacyKeypair);
    await repositories.keyRingRepository.setLastAllocatedIndex('p2pk', 12);

    const results = await Promise.all([
      runner.run((tx) => tx.keypairs.importP2pk(importedKey)),
      runner.run((tx) => tx.keypairs.importP2pk(importedKey)),
    ]);

    expect(results).toEqual([legacyKeypair, legacyKeypair]);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      legacyKeypair,
    ]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(12);
  });

  it('deduplicates concurrent imports into an empty keyring', async () => {
    await Promise.all([
      runner.run((tx) => tx.keypairs.importP2pk(importedKey)),
      runner.run((tx) => tx.keypairs.importP2pk(importedKey)),
    ]);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toHaveLength(1);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBeNull();
  });

  it('resolves import and deletion against preceding writes in the same scope', async () => {
    await runner.run(async (scope) => {
      await scope.keypairs.importP2pk(legacyKeypair);
      expect(await scope.keypairs.importP2pk(importedKey)).toEqual(legacyKeypair);
      await scope.keypairs.deleteP2pk(canonicalKey);
    });
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
  });

  it('uses one transaction for alias reads and deletion without changing allocation state', async () => {
    await repositories.keyRingRepository.setPersistedKeyPair(legacyKeypair);
    await repositories.keyRingRepository.setLastAllocatedIndex('p2pk', 12);
    const transactionStarted = mock(() => {});
    const transactionRunner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) => {
        transactionStarted();
        return repositories.withTransaction(work);
      }),
    );
    await transactionRunner.run((tx) => tx.keypairs.deleteP2pk(canonicalKey));

    expect(transactionStarted).toHaveBeenCalledTimes(1);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(12);
  });

  it('returns import results only after commit and preserves them on a repeated import', async () => {
    const transactionStarted = mock(() => {});
    const transactionRunner = new RepositoryCoreTransactionRunner(
      overrideTransactions(repositories, (work) => {
        transactionStarted();
        return repositories.withTransaction(work);
      }),
    );
    const first = await transactionRunner.run((tx) => tx.keypairs.importP2pk(importedKey));
    expect(await repositories.keyRingRepository.getPersistedKeyPair(canonicalKey, 'p2pk')).toEqual(
      expect.objectContaining(first),
    );
    const second = await transactionRunner.run((tx) => tx.keypairs.importP2pk(importedKey));
    expect(second).toEqual(expect.objectContaining(first));
    expect(transactionStarted).toHaveBeenCalledTimes(2);
  });

  it('rolls alias deletion back with the owning transaction', async () => {
    await repositories.keyRingRepository.setPersistedKeyPair(legacyKeypair);
    await expect(
      runner.run(async (scope) => {
        await scope.keypairs.deleteP2pk(canonicalKey);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([
      legacyKeypair,
    ]);
  });

  it('rolls import back with the owning transaction', async () => {
    await expect(
      runner.run(async (scope) => {
        await scope.keypairs.importP2pk(importedKey);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
  });

  it('does not delete a mint quote key through either P2PK encoding', async () => {
    const quoteKey: Keypair = { ...importedKey, purpose: 'nut20_mint_quote' };
    await repositories.keyRingRepository.setPersistedKeyPair(quoteKey);
    await runner.run((tx) => tx.keypairs.deleteP2pk(legacyKey));
    await runner.run((tx) => tx.keypairs.deleteP2pk(canonicalKey));
    expect(
      await repositories.keyRingRepository.getPersistedKeyPair(canonicalKey, 'nut20_mint_quote'),
    ).toEqual(expect.objectContaining(quoteKey));
  });

  it('rejects an import that would overwrite a mint quote key', async () => {
    const quoteKey: Keypair = {
      ...importedKey,
      purpose: 'nut20_mint_quote',
      derivationIndex: 7,
    };
    await repositories.keyRingRepository.setPersistedKeyPair(quoteKey);
    await repositories.keyRingRepository.setLastAllocatedIndex('nut20_mint_quote', 12);
    await repositories.keyRingRepository.setLastAllocatedIndex('p2pk', 3);

    await expect(runner.run((tx) => tx.keypairs.importP2pk(importedKey))).rejects.toThrow(
      MintQuoteKeyError,
    );

    expect(
      await repositories.keyRingRepository.getPersistedKeyPair(canonicalKey, 'nut20_mint_quote'),
    ).toEqual(quoteKey);
    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs('p2pk')).toEqual([]);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('nut20_mint_quote')).toBe(12);
    expect(await repositories.keyRingRepository.getLastAllocatedIndex('p2pk')).toBe(3);
  });

  it('rejects a conflicting import after a quote key allocation in the same transaction', async () => {
    await expect(
      runner.run(async (scope) => {
        await scope.keypairs.allocate({
          purpose: 'nut20_mint_quote',
          derive: () => ({ publicKeyHex: canonicalKey, secretKey: importedKey.secretKey }),
        });
        await scope.keypairs.importP2pk(importedKey);
      }),
    ).rejects.toThrow(MintQuoteKeyError);

    expect(await repositories.keyRingRepository.getAllPersistedKeyPairs()).toEqual([]);
    expect(
      await repositories.keyRingRepository.getLastAllocatedIndex('nut20_mint_quote'),
    ).toBeNull();
  });
});
