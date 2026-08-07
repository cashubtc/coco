import type {
  AuthSessionRepository,
  CounterRepository,
  HistoryProjectionRepository,
  KeyRingRepository,
  KeysetRepository,
  LegacyMintQuoteRepository,
  MeltQuoteRepository,
  MeltOperationRepository,
  MintQuoteRepository,
  MintRepository,
  ProofRepository,
  Repositories,
  RepositoryTransactionScope,
  SendOperationRepository,
  MintOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  ReceiveOperationRepository,
  MintSwapRepositoryCapability,
} from '..';
import { MemoryAuthSessionRepository } from './MemoryAuthSessionRepository';
import { MemoryCounterRepository } from './MemoryCounterRepository';
import { MemoryHistoryRepository } from './MemoryHistoryRepository';
import { MemoryKeyRingRepository } from './MemoryKeyRingRepository';
import { MemoryKeysetRepository } from './MemoryKeysetRepository';
import { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import { MemoryMeltQuoteRepository } from './MemoryMeltQuoteRepository';
import { MemoryLegacyMintQuoteRepository } from './MemoryLegacyMintQuoteRepository';
import { MemoryMintQuoteRepository } from './MemoryMintQuoteRepository';
import { MemoryMintRepository } from './MemoryMintRepository';
import { MemoryProofRepository } from './MemoryProofRepository';
import { MemorySendOperationRepository } from './MemorySendOperationRepository';
import { MemoryMintOperationRepository } from './MemoryMintOperationRepository';
import { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import {
  MemoryPaymentRequestReceiveAttemptRepository,
  MemoryPaymentRequestReceiveOperationRepository,
} from './MemoryPaymentRequestReceiveRepository';
import {
  applyMemoryRepositoryState,
  copyMemoryRepositoryState,
  snapshotMemoryRepositoryState,
} from './clone';
import { MemoryRepositoryCoordinator } from './MemoryRepositoryCoordinator';
import { MemoryMintSwapOperationRepository } from './MemoryMintSwapOperationRepository';
import { MemoryOperationEventOutboxRepository } from './MemoryOperationEventOutboxRepository';

type MemoryRepositoryScope = RepositoryTransactionScope & {
  keyRingRepository: KeyRingRepository;
};

export class MemoryRepositories implements Repositories {
  mintRepository: MintRepository;
  keyRingRepository: KeyRingRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  legacyMintQuoteRepository: LegacyMintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
  historyRepository: HistoryProjectionRepository;
  sendOperationRepository: SendOperationRepository;
  meltOperationRepository: MeltOperationRepository;
  authSessionRepository: AuthSessionRepository;
  mintOperationRepository: MintOperationRepository;
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  mintSwap: MintSwapRepositoryCapability;

  private readonly coordinator = new MemoryRepositoryCoordinator();
  private readonly rawScope: MemoryRepositoryScope;

  constructor() {
    this.rawScope = createMemoryRepositoryScope();
    this.mintRepository = this.coordinator.wrap(this.rawScope.mintRepository);
    this.keyRingRepository = this.coordinator.wrap(this.rawScope.keyRingRepository);
    this.counterRepository = this.coordinator.wrap(this.rawScope.counterRepository);
    this.keysetRepository = this.coordinator.wrap(this.rawScope.keysetRepository);
    this.proofRepository = this.coordinator.wrap(this.rawScope.proofRepository);
    this.mintQuoteRepository = this.coordinator.wrap(this.rawScope.mintQuoteRepository);
    this.legacyMintQuoteRepository = this.coordinator.wrap(this.rawScope.legacyMintQuoteRepository);
    this.meltQuoteRepository = this.coordinator.wrap(this.rawScope.meltQuoteRepository);
    this.historyRepository = this.coordinator.wrap(this.rawScope.historyRepository);
    this.sendOperationRepository = this.coordinator.wrap(this.rawScope.sendOperationRepository);
    this.meltOperationRepository = this.coordinator.wrap(this.rawScope.meltOperationRepository);
    this.authSessionRepository = this.coordinator.wrap(this.rawScope.authSessionRepository);
    this.mintOperationRepository = this.coordinator.wrap(this.rawScope.mintOperationRepository);
    this.receiveOperationRepository = this.coordinator.wrap(
      this.rawScope.receiveOperationRepository,
    );
    this.paymentRequestReceiveOperationRepository = this.coordinator.wrap(
      this.rawScope.paymentRequestReceiveOperationRepository,
    );
    this.paymentRequestReceiveAttemptRepository = this.coordinator.wrap(
      this.rawScope.paymentRequestReceiveAttemptRepository,
    );
    const rawMintSwap = this.rawScope.mintSwap;
    if (!rawMintSwap) throw new Error('Memory Mint Swap repositories were not initialized');
    this.mintSwap = {
      mintSwapOperationRepository: this.coordinator.wrap(rawMintSwap.mintSwapOperationRepository),
      operationEventOutboxRepository: this.coordinator.wrap(
        rawMintSwap.operationEventOutboxRepository,
      ),
    };
  }

  async init(): Promise<void> {
    // No-op: Memory repositories don't require initialization
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.coordinator.runExclusive(async () => {
      const staged = createMemoryRepositoryScope();
      copyRepositoryScope(this.rawScope, staged);
      const result = await fn(staged);
      commitRepositoryScope(staged, this.rawScope);
      return result;
    });
  }
}

function commitRepositoryScope(
  source: RepositoryTransactionScope,
  target: RepositoryTransactionScope,
): void {
  const entries = getRepositoryStateEntries(source, target);
  // Clone every repository first. A cloning failure cannot leave a partially committed scope.
  const prepared = entries.map(({ sourceRepository, targetRepository, excludedKeys }) => ({
    targetRepository,
    snapshot: snapshotMemoryRepositoryState(sourceRepository, excludedKeys),
  }));
  for (const { targetRepository, snapshot } of prepared) {
    applyMemoryRepositoryState(targetRepository, snapshot);
  }
}

function createMemoryRepositoryScope(): MemoryRepositoryScope {
  const mintRepository = new MemoryMintRepository();
  const keyRingRepository = new MemoryKeyRingRepository();
  const counterRepository = new MemoryCounterRepository();
  const keysetRepository = new MemoryKeysetRepository();
  const proofRepository = new MemoryProofRepository();
  const sendOperationRepository = new MemorySendOperationRepository();
  const meltOperationRepository = new MemoryMeltOperationRepository();
  const mintOperationRepository = new MemoryMintOperationRepository();
  const receiveOperationRepository = new MemoryReceiveOperationRepository();
  const mintQuoteRepository = new MemoryMintQuoteRepository();
  const legacyMintQuoteRepository = new MemoryLegacyMintQuoteRepository();
  const meltQuoteRepository = new MemoryMeltQuoteRepository();
  const historyRepository = new MemoryHistoryRepository({
    sendOperationRepository,
    meltOperationRepository,
    mintOperationRepository,
    mintQuoteRepository,
    receiveOperationRepository,
  });

  return {
    mintRepository,
    keyRingRepository,
    counterRepository,
    keysetRepository,
    proofRepository,
    mintQuoteRepository,
    legacyMintQuoteRepository,
    meltQuoteRepository,
    historyRepository,
    sendOperationRepository,
    meltOperationRepository,
    authSessionRepository: new MemoryAuthSessionRepository(),
    mintOperationRepository,
    receiveOperationRepository,
    paymentRequestReceiveOperationRepository: new MemoryPaymentRequestReceiveOperationRepository(),
    paymentRequestReceiveAttemptRepository: new MemoryPaymentRequestReceiveAttemptRepository(),
    mintSwap: {
      mintSwapOperationRepository: new MemoryMintSwapOperationRepository(),
      operationEventOutboxRepository: new MemoryOperationEventOutboxRepository(),
    },
  };
}

function copyRepositoryScope(
  source: RepositoryTransactionScope,
  target: RepositoryTransactionScope,
): void {
  for (const { sourceRepository, targetRepository, excludedKeys } of getRepositoryStateEntries(
    source,
    target,
  )) {
    copyMemoryRepositoryState(sourceRepository, targetRepository, excludedKeys);
  }
}

function getRepositoryStateEntries(
  source: RepositoryTransactionScope,
  target: RepositoryTransactionScope,
): Array<{ sourceRepository: object; targetRepository: object; excludedKeys: readonly string[] }> {
  const repositoryKeys: Array<Exclude<keyof RepositoryTransactionScope, 'mintSwap'>> = [
    'mintRepository',
    'keyRingRepository',
    'counterRepository',
    'keysetRepository',
    'proofRepository',
    'mintQuoteRepository',
    'legacyMintQuoteRepository',
    'meltQuoteRepository',
    'historyRepository',
    'sendOperationRepository',
    'meltOperationRepository',
    'authSessionRepository',
    'mintOperationRepository',
    'receiveOperationRepository',
    'paymentRequestReceiveOperationRepository',
    'paymentRequestReceiveAttemptRepository',
  ];
  if (!source.mintSwap || !target.mintSwap) {
    throw new Error('Memory Mint Swap repository capability is missing');
  }
  return [
    ...repositoryKeys.map((key) => ({
      sourceRepository: source[key],
      targetRepository: target[key],
      excludedKeys: key === 'historyRepository' ? ['operationRepositories'] : [],
    })),
    {
      sourceRepository: source.mintSwap.mintSwapOperationRepository,
      targetRepository: target.mintSwap.mintSwapOperationRepository,
      excludedKeys: [],
    },
    {
      sourceRepository: source.mintSwap.operationEventOutboxRepository,
      targetRepository: target.mintSwap.operationEventOutboxRepository,
      excludedKeys: [],
    },
  ];
}
