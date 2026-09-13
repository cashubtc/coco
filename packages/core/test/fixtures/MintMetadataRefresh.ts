import { mock } from 'bun:test';
import { MintService } from '../../services/MintService.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import { CoreMintTransactions } from '../../transactions/mints/MintTransactions.ts';
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

export function createMintServiceDependencies(repositories: Repositories) {
  return {
    queries: new StoredMintQueries(repositories.mintRepository, repositories.keysetRepository),
    transactions: new CoreMintTransactions(new RepositoryCoreTransactionRunner(repositories)),
  };
}

/** Exercise mint management through real query and transaction dependencies. */
export function createMintServiceForMetadata(
  repositories: Repositories,
  remote: Pick<MintAdapter, 'fetchMintMetadata'> = createMintMetadataRemoteDouble(),
  events = new EventBus<CoreEvents>(),
) {
  return new MintService(remote, createMintServiceDependencies(repositories), undefined, events);
}
