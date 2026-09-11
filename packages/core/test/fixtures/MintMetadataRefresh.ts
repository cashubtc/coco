import { mock } from 'bun:test';
import { MintService } from '../../services/MintService.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { CoreMintMetadataTransactions } from '../../transactions/mints/MintMetadataTransactions.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import type { Repositories } from '../../repositories/index.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';

export function createMintMetadataRemoteDouble() {
  return {
    fetchMintMetadata: mock<MintAdapter['fetchMintMetadata']>(async () => {
      throw new Error('Unexpected mint metadata refresh');
    }),
  };
}

export function createMintMetadataRefreshDependencies(
  repositories: Repositories,
  remote: Pick<MintAdapter, 'fetchMintMetadata'> = createMintMetadataRemoteDouble(),
) {
  return {
    queries: new StoredMintQueries(repositories.mintRepository, repositories.keysetRepository),
    remote,
    transactions: new CoreMintMetadataTransactions(
      new RepositoryCoreTransactionRunner(repositories),
    ),
  };
}

/** Exercise the real shared action; legacy MintService methods are outside this fixture's scope. */
export function createMintServiceForMetadata(
  repositories: Repositories,
  remote: Pick<MintAdapter, 'fetchMintMetadata'> = createMintMetadataRemoteDouble(),
  events = new EventBus<CoreEvents>(),
) {
  const unusedAdapter = {} as MintAdapter;
  return new MintService(
    repositories.mintRepository,
    repositories.keysetRepository,
    unusedAdapter,
    createMintMetadataRefreshDependencies(repositories, remote),
    undefined,
    events,
  );
}
