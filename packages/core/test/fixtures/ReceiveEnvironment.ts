import { Amount, deriveKeysetId, type OutputDataCreator, type Proof } from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { KeypairP2pkSigner } from '../../keypairs/P2pkSigner.ts';
import { StoredMintQueries } from '../../mints/MintMetadata.ts';
import {
  ReceiveOperationService,
  type ReceiveOperationServiceDependencies,
} from '../../operations/receive/ReceiveOperationService.ts';
import type { RepositoryTransactionScope } from '../../repositories';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import {
  createCoreTransactionModuleFactory,
  RepositoryCoreTransactionRunner,
} from '../../transactions/CoreTransaction.ts';
import { CoreReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import { testMintInfo, testMintKeypairs } from './MintMetadata.ts';
import { makeOutputDataCreator } from './OutputDataCreator.ts';
import { createReceiveRemoteDouble } from './ReceiveRemote.ts';

export const receiveMintUrl = 'https://mint.test';
export const receiveKeysetId = deriveKeysetId(testMintKeypairs, { versionByte: 0, unit: 'sat' });
export function receiveInput(secret = 'input', amount = 10): Proof {
  return { id: receiveKeysetId, amount: Amount.from(amount), secret, C: `C_${secret}` };
}

export class ReceiveTestRepositories extends MemoryRepositories {
  transactionOpen = false;
  transactionCount = 0;
  override withTransaction<T>(fn: (scope: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    this.transactionCount++;
    return super.withTransaction(async (scope) => {
      this.transactionOpen = true;
      try {
        return await fn(scope);
      } finally {
        this.transactionOpen = false;
      }
    });
  }
}

export async function createReceiveEnvironment(
  repositories = new ReceiveTestRepositories(),
  creator?: OutputDataCreator,
) {
  await repositories.mintRepository.addOrUpdateMint({
    mintUrl: receiveMintUrl,
    name: 'Test',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: Math.floor(Date.now() / 1000),
  });
  await repositories.keysetRepository.addKeyset({
    mintUrl: receiveMintUrl,
    id: receiveKeysetId,
    unit: 'sat',
    active: true,
    feePpk: 0,
    keypairs: testMintKeypairs,
  });
  const outputDataCreator =
    creator ??
    makeOutputDataCreator({
      createDeterministicData: (amount, _seed, counter, keys) => [
        {
          blindedMessage: { id: keys.id, amount: Amount.from(amount), B_: `B_${counter}` },
          secret: new TextEncoder().encode(`output-${counter}`),
          blindingFactor: BigInt(counter + 1),
          toProof: () => {
            throw new Error('not used');
          },
        },
      ],
    });
  const runner = new RepositoryCoreTransactionRunner(
    repositories,
    createCoreTransactionModuleFactory(outputDataCreator),
  );
  const transactions = new CoreReceiveTransactions(runner);
  const remote = createReceiveRemoteDouble();
  const eventBus = new EventBus<CoreEvents>();
  const loadSeed = mock(async () => new Uint8Array(64).fill(1));
  const dependencies: ReceiveOperationServiceDependencies = {
    operationQueries: repositories.receiveOperationRepository,
    proofQueries: repositories.proofRepository,
    mintQueries: new StoredMintQueries(repositories.mintRepository, repositories.keysetRepository),
    signer: new KeypairP2pkSigner(repositories.keyRingRepository),
    transactions,
    remote,
    eventBus,
    loadSeed,
  };
  const buildService = (overrides: Partial<ReceiveOperationServiceDependencies> = {}) =>
    new ReceiveOperationService({ ...dependencies, ...overrides });
  const service = buildService();
  return {
    repositories,
    runner,
    transactions,
    remote,
    eventBus,
    loadSeed,
    dependencies,
    buildService,
    service,
  };
}
