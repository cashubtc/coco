import type { OutputDataCreator } from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { DefaultSendHandler } from '../../infra/handlers/send/DefaultSendHandler.ts';
import { P2pkSendHandler } from '../../infra/handlers/send/P2pkSendHandler.ts';
import { SendHandlerProvider } from '../../infra/handlers/send/SendHandlerProvider.ts';
import { SendOperationService } from '../../operations/send/SendOperationService.ts';
import type { RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from './MintMetadata.ts';
import {
  createMintMetadataRemoteDouble,
  createMintServiceForMetadata,
} from './MintMetadataRefresh.ts';
import { createSendRemoteDouble } from './SendRemote.ts';

class ObservedMemoryRepositories extends MemoryRepositories {
  transactionCount = 0;
  transactionOpen = false;

  override withTransaction<T>(work: (scope: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    this.transactionCount++;
    return super.withTransaction(async (scope) => {
      this.transactionOpen = true;
      try {
        return await work(scope);
      } finally {
        this.transactionOpen = false;
      }
    });
  }
}

/** Real Send persistence and orchestration, with in-memory remote effects. */
export async function createSendEnvironment(units = ['sat']) {
  const mintUrl = 'https://mint.test';
  const repositories = new ObservedMemoryRepositories();
  await repositories.mintRepository.addNewMint({
    mintUrl,
    name: 'Test',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: Math.floor(Date.now() / 1000),
  });
  for (const unit of units) {
    await repositories.keysetRepository.addKeyset({
      mintUrl,
      id: testMintKeysetId(unit),
      unit,
      keypairs: testMintKeypairs,
      active: true,
      feePpk: 0,
    });
  }
  const transactionRunner = new RepositoryCoreTransactionRunner(repositories);
  const eventBus = new EventBus<CoreEvents>();
  const remote = createSendRemoteDouble();
  const metadataRemote = createMintMetadataRemoteDouble();
  const loadSeed = mock(async () => new Uint8Array(32).fill(1));
  const logger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };

  const buildService = (
    overrides: {
      eventBus?: EventBus<CoreEvents>;
      outputDataCreator?: OutputDataCreator;
    } = {},
  ) =>
    new SendOperationService({
      operationQueries: repositories.sendOperationRepository,
      proofQueries: repositories.proofRepository,
      transactionRunner,
      mintQueries: repositories.mintRepository,
      mintMetadataRefresh: createMintServiceForMetadata(
        repositories,
        metadataRemote,
        overrides.eventBus ?? eventBus,
      ),
      remote,
      loadSeed,
      eventBus,
      handlerProvider: new SendHandlerProvider({
        default: new DefaultSendHandler(),
        p2pk: new P2pkSendHandler(),
      }),
      logger,
      ...overrides,
    });

  return {
    repositories,
    transactionRunner,
    eventBus,
    remote,
    metadataRemote,
    loadSeed,
    logger,
    buildService,
    service: buildService(),
  };
}
