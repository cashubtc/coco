import { Amount, type Proof, type ProofState, type Token } from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { KeypairP2pkSigner } from '../../keypairs/P2pkSigner.ts';
import {
  ReceiveOperationService,
  type ReceiveOperationServiceDependencies,
} from '../../operations/receive/ReceiveOperationService.ts';
import type { ReceiveRemoteSession } from '../../operations/receive/ReceiveRemote.ts';
import type { PreparedOrLaterOperation } from '../../operations/receive/ReceiveOperation.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreReceiveTransactions } from '../../transactions/receive/ReceiveTransactions.ts';
import {
  computeYHexForSecrets,
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
  type SerializedOutputData,
} from '../../utils.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from './MintMetadata.ts';
import {
  createMintMetadataRemoteDouble,
  createMintServiceForMetadata,
} from './MintMetadataRefresh.ts';

export const receiveMint = 'https://mint.test';
export const receiveKeys = testMintKeysetId();

export class ReceiveTestRepositories extends MemoryRepositories {
  transactionOpen = false;
  transactionCount = 0;
  failNextCommit = false;
  override withTransaction<T>(work: (scope: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return super.withTransaction(async (scope) => {
      this.transactionCount++;
      this.transactionOpen = true;
      try {
        const result = await work(scope);
        if (this.failNextCommit) {
          this.failNextCommit = false;
          throw new Error('Injected commit failure');
        }
        return result;
      } finally {
        this.transactionOpen = false;
      }
    });
  }
}

export function receiveToken(amount = 7, secret = 'incoming'): Token {
  return {
    mint: receiveMint,
    unit: 'sat',
    proofs: [8, 4, 2, 1]
      .filter((value) => (amount & value) !== 0)
      .map((value, i) => ({
        id: receiveKeys,
        amount: Amount.from(value),
        secret: i === 0 ? secret : secret + '-' + i,
        C: testMintKeypairs['1'],
      })),
  };
}

export function issuedProofs(outputData: SerializedOutputData): Proof[] {
  const secrets = getSecretsFromSerializedOutputData(outputData).keepSecrets;
  return outputData.keep.map((output, i) => ({
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: secrets[i]!,
    C: testMintKeypairs['1'],
  }));
}

export function receivedCoreProofs(operation: PreparedOrLaterOperation) {
  return mapProofToCoreProof(operation.mintUrl, 'ready', issuedProofs(operation.outputData), {
    unit: operation.unit,
    createdByOperationId: operation.id,
  });
}

export function proofStates(
  proofs: readonly Proof[],
  state: 'UNSPENT' | 'SPENT' | 'PENDING' = 'UNSPENT',
): ProofState[] {
  return computeYHexForSecrets(proofs.map((proof) => proof.secret)).map((Y) => ({
    Y,
    state,
    witness: null,
  })) as ProofState[];
}

/** Real persistence and signing with controllable remote effects. */
export async function createReceiveEnvironment(
  repositories: Repositories = new ReceiveTestRepositories(),
) {
  await repositories.mintRepository.addNewMint({
    mintUrl: receiveMint,
    name: 'Test',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: Math.floor(Date.now() / 1000),
  });
  await repositories.keysetRepository.addKeyset({
    mintUrl: receiveMint,
    id: receiveKeys,
    unit: 'sat',
    keypairs: testMintKeypairs,
    active: true,
    feePpk: 0,
  });
  const transactions = new CoreReceiveTransactions(
    new RepositoryCoreTransactionRunner(repositories),
  );
  const eventBus = new EventBus<CoreEvents>();
  const remoteSession = {
    receive: mock<ReceiveRemoteSession['receive']>(async (request) =>
      issuedProofs(request.outputData),
    ),
    checkProofStates: mock<ReceiveRemoteSession['checkProofStates']>(async () => {
      throw new Error('Mint offline');
    }),
    restoreOutputs: mock<ReceiveRemoteSession['restoreOutputs']>(async () => []),
  };
  const remote = { ...remoteSession, open: mock(() => remoteSession) };
  const loadSeed = mock(async () => new Uint8Array(32).fill(1));
  const logger = {
    debug: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  };
  const metadataRemote = createMintMetadataRemoteDouble();
  const dependencies: ReceiveOperationServiceDependencies = {
    operations: repositories.receiveOperationRepository,
    transactions,
    mintQueries: repositories.mintRepository,
    mintMetadataRefresh: createMintServiceForMetadata(repositories, metadataRemote, eventBus),
    signer: new KeypairP2pkSigner(repositories.keyRingRepository),
    loadSeed,
    remote,
    eventBus,
    logger,
  };
  const buildService = (overrides: Partial<ReceiveOperationServiceDependencies> = {}) =>
    new ReceiveOperationService({ ...dependencies, ...overrides });
  const service = buildService();
  const prepare = async (token = receiveToken()) => service.prepare(await service.init(token));
  return {
    repositories,
    transactions,
    eventBus,
    remote,
    loadSeed,
    logger,
    metadataRemote,
    buildService,
    service,
    prepare,
  };
}
