import { describe, expect, it, mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { overrideTransactions } from '../overrideTransactions.ts';
import {
  createMintMetadataRemoteDouble,
  createMintServiceForMetadata,
} from '../fixtures/MintMetadataRefresh.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://mint.test';
const keyset = {
  mintUrl,
  id: testMintKeysetId(),
  unit: 'sat',
  keypairs: testMintKeypairs,
  active: true,
  feePpk: 0,
};

async function environment() {
  const repositories = new MemoryRepositories();
  await repositories.mintRepository.addNewMint({
    mintUrl,
    name: 'Test',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: 0,
  });
  await repositories.keysetRepository.addKeyset(keyset);
  const events = new EventBus<CoreEvents>();
  const remote = createMintMetadataRemoteDouble();
  let transactionOpen = false;
  const withTransaction = mock(() => {});
  const controlled = overrideTransactions(
    repositories,
    <T>(work: (scope: RepositoryTransactionScope) => Promise<T>) => {
      withTransaction();
      return repositories.withTransaction(async (scope) => {
        transactionOpen = true;
        try {
          return await work(scope);
        } finally {
          transactionOpen = false;
        }
      });
    },
  );
  const service = createMintServiceForMetadata(controlled, remote, events);
  remote.fetchMintMetadata.mockImplementation(async () => {
    expect(transactionOpen).toBe(false);
    return {
      mintUrl,
      mintInfo: { ...testMintInfo, name: 'Refreshed' },
      keysets: [{ ...keyset, active: false }],
      observedAt: Math.floor(Date.now() / 1000),
    };
  });
  return {
    repositories,
    events,
    remote,
    withTransaction,
    service,
    isTransactionOpen: () => transactionOpen,
  };
}

describe('MintService.refreshAndCommitIfStale', () => {
  it('returns fresh metadata without a fetch, transaction, or events through either entry point', async () => {
    const { repositories, events, remote, withTransaction, service } = await environment();
    const mint = await repositories.mintRepository.getMintByUrl(mintUrl);
    await repositories.mintRepository.updateMint({
      ...mint,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    const published = mock(() => {});
    events.on('mint:updated', published);
    const result = await service.refreshAndCommitIfStale(`${mintUrl}/`);
    expect(result.mint.mintUrl).toBe(mintUrl);
    expect(await service.ensureUpdatedMint(mintUrl)).toEqual(result);
    expect(remote.fetchMintMetadata).not.toHaveBeenCalled();
    expect(withTransaction).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
  });

  it('commits stale metadata once and publishes the committed snapshot outside the transaction', async () => {
    const { repositories, events, remote, withTransaction, service, isTransactionOpen } =
      await environment();
    const published: string[] = [];
    events.on('mint:metadata-refreshed', async () => {
      expect(isTransactionOpen()).toBe(false);
      expect((await repositories.mintRepository.getMintByUrl(mintUrl)).mintInfo.name).toBe(
        'Refreshed',
      );
      published.push('refreshed');
    });
    events.on('mint:updated', async (metadata) => {
      expect(isTransactionOpen()).toBe(false);
      expect(metadata.keysets[0]?.active).toBe(false);
      expect(metadata.mint.trusted).toBe(true);
      published.push('updated');
    });
    const result = await service.refreshAndCommitIfStale(`${mintUrl}/`);
    expect(result.mint.mintInfo.name).toBe('Refreshed');
    expect(remote.fetchMintMetadata).toHaveBeenCalledWith(mintUrl, [
      expect.objectContaining(keyset),
    ]);
    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(published).toEqual(['refreshed', 'updated']);
    await service.ensureUpdatedMint(mintUrl);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not open a transaction or publish success when fetching fails', async () => {
    const { repositories, events, remote, withTransaction, service } = await environment();
    remote.fetchMintMetadata.mockRejectedValue(new Error('fetch failed'));
    const published = mock(() => {});
    events.on('mint:metadata-refreshed', published);
    events.on('mint:updated', published);
    await expect(service.refreshAndCommitIfStale(mintUrl)).rejects.toThrow('fetch failed');
    expect(withTransaction).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(0);
  });

  it('rolls back all metadata and emits no success events when persistence fails', async () => {
    const { repositories, remote, events } = await environment();
    const controlled = overrideTransactions(repositories, (work) =>
      repositories.withTransaction(async (scope) => {
        scope.mintRepository.addOrUpdateMint = async () => {
          throw new Error('write failed');
        };
        return work(scope);
      }),
    );
    const service = createMintServiceForMetadata(controlled, remote, events);
    const published = mock(() => {});
    events.on('mint:metadata-refreshed', published);
    events.on('mint:updated', published);
    await expect(service.refreshAndCommitIfStale(mintUrl)).rejects.toThrow('write failed');
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBe(0);
    expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
      true,
    );
    expect(published).not.toHaveBeenCalled();
  });

  it('retains a committed refresh and attempts the next event after a listener failure', async () => {
    const { repositories, events, service } = await environment();
    events.on('mint:metadata-refreshed', () => {
      throw new Error('listener failed');
    });
    const updated = mock(() => {});
    events.on('mint:updated', updated);
    const result = await service.refreshAndCommitIfStale(mintUrl);
    expect(result.mint.mintInfo.name).toBe('Refreshed');
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).updatedAt).toBeGreaterThan(0);
    expect(updated).toHaveBeenCalledTimes(1);
  });

  it('creates unknown metadata atomically as untrusted', async () => {
    const { repositories, remote, service } = await environment();
    await repositories.mintRepository.deleteMint(mintUrl);
    const result = await service.refreshAndCommitIfStale(mintUrl);
    expect(result.mint.trusted).toBe(false);
    expect(remote.fetchMintMetadata).toHaveBeenCalledWith(mintUrl, []);
    expect((await repositories.mintRepository.getMintByUrl(mintUrl)).trusted).toBe(false);
  });

  it('retains its independent commit when the caller later rolls back a transaction', async () => {
    const { repositories, service } = await environment();
    await service.refreshAndCommitIfStale(mintUrl);
    await expect(
      repositories.withTransaction(async (scope) => {
        const mint = await scope.mintRepository.getMintByUrl(mintUrl);
        await scope.mintRepository.updateMint({ ...mint, name: 'Caller change' });
        throw new Error('caller failed');
      }),
    ).rejects.toThrow('caller failed');
    const persisted = await repositories.mintRepository.getMintByUrl(mintUrl);
    expect(persisted.name).toBe('Test');
    expect(persisted.mintInfo.name).toBe('Refreshed');
    expect((await repositories.keysetRepository.getKeysetById(mintUrl, keyset.id))?.active).toBe(
      false,
    );
  });
});
