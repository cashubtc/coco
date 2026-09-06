import { describe, expect, it } from 'bun:test';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreSendTransactions } from '../../transactions/send/SendTransactions.ts';
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

describe('Mint metadata in Send preflight', () => {
  it('returns missing or stale stored metadata without opening a transaction or refreshing it', async () => {
    const repositories = new MemoryRepositories();
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
    const repositories = new MemoryRepositories();
    await repositories.mintRepository.addNewMint({ ...original, trusted: false });
    await repositories.keysetRepository.addKeyset(keyset);
    const transactions = new CoreSendTransactions(
      new RepositoryCoreTransactionRunner(repositories),
    );
    const result = await transactions.refreshMintMetadata(observation);
    expect(result.mint.trusted).toBe(false);
    expect(result.mint.mintInfo.name).toBe('Refreshed');
    expect(result.keysets[0]?.active).toBe(false);
  });

  it('rolls back keyset refreshes if the mint snapshot cannot be persisted', async () => {
    const repositories = new MemoryRepositories();
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
    const transactions = new CoreSendTransactions(new RepositoryCoreTransactionRunner(controlled));
    await expect(transactions.refreshMintMetadata(observation)).rejects.toThrow(
      'metadata write failed',
    );
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(10);
    expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
      true,
    );
  });
});
