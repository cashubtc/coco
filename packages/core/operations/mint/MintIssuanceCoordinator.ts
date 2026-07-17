import type { BatchMintPreview, Proof } from '@cashu/cashu-ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { MintHandlerProvider } from '../../infra/handlers/mint/MintHandlerProvider.ts';
import type { MintQuotePollingChecker } from '../../infra/MintQuotePollingChecker.ts';
import { mintQuoteGroupKey } from '../../infra/MintQuotePollingKey.ts';
import type { Logger } from '../../logging/Logger.ts';
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  UnknownMintError,
} from '../../models/Error.ts';
import {
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  type MintQuote,
} from '../../models/MintQuote.ts';
import { isMintQuoteExpired } from '../../models/MintQuoteExpiry.ts';
import {
  getNut29MintQuoteCheckLimit,
  Nut29BatchLimitCache,
  supportsNut29MintQuoteCheck,
} from '../../quotes/MintQuoteBatchTransport.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import {
  deserializeOutputData,
  generateSubId,
  mapProofToCoreProof,
  normalizeMintUrl,
  serializeOutputData,
} from '../../utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import type { MintIssuanceAttempt } from './MintIssuanceAttempt.ts';
import type {
  MintExecutionResult,
  MintMethod,
  RecoverExecutingResult,
} from './MintMethodHandler.ts';
import type {
  ExecutingMintOperationRecord,
  FailedMintOperationRecord,
  FinalizedMintOperationRecord,
  MintOperation,
  MintOperationRecord,
  PendingMintOperationRecord,
} from './MintOperation.ts';
import { isTerminalOperation, toMintOperation } from './MintOperation.ts';

interface MintIssuanceCoordinatorOptions {
  repositories: Repositories;
  proofService: ProofService;
  mintService: MintService;
  walletService: WalletService;
  mintAdapter: MintAdapter;
  mintHandlerProvider?: MintHandlerProvider;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
  nut29BatchLimitCache?: Nut29BatchLimitCache;
  mintQuotePollingChecker?: MintQuotePollingChecker;
}

type CreatedAttempt =
  | {
      attempt: MintIssuanceAttempt;
      operationId: string;
      newlyCreated: false;
    }
  | {
      attempt: MintIssuanceAttempt;
      operations: ExecutingMintOperationRecord<'bolt11'>[];
      newlyCreated: true;
    };

type ConfirmedBatchRejectionKind = 'state' | 'batch-size' | 'incompatibility' | 'validation';

interface ConfirmedBatchRejection {
  kind: ConfirmedBatchRejectionKind;
  error: Error;
  protocolCode?: number;
  httpStatus?: number;
}

const CONFIRMED_BATCH_REJECTION_CODE = 'CONFIRMED_BATCH_REJECTION';
const AUTHENTICATION_ERROR_CODE_MIN = 30_000;
const NUT29_BATCH_SIZE_ERROR_CODE = 11_017;
const MINT_QUOTE_STATE_ERROR_CODES = new Set([20_001, 20_002]);
const INCOMPATIBLE_ENDPOINT_STATUSES = new Set([404, 405, 501]);
const CONFIRMED_BATCH_REJECTION_KINDS: ConfirmedBatchRejectionKind[] = [
  'state',
  'batch-size',
  'incompatibility',
  'validation',
];

interface ConfirmedBatchRejectionProgress {
  kind: ConfirmedBatchRejectionKind;
  observedQuoteIds: string[];
  capabilityUpdatedAt?: number;
  replacementBatchLimit?: number;
}

interface BatchRecoveryContext {
  attempt: MintIssuanceAttempt;
  operations: ExecutingMintOperationRecord<'bolt11'>[];
  targetOperationId: string;
}

function isConfirmedBatchRejectionKind(value: unknown): value is ConfirmedBatchRejectionKind {
  return (
    typeof value === 'string' && CONFIRMED_BATCH_REJECTION_KINDS.some((kind) => kind === value)
  );
}

function getConfirmedBatchRejectionProgress(
  attempt: MintIssuanceAttempt,
): ConfirmedBatchRejectionProgress | null {
  if (attempt.terminalError?.code !== CONFIRMED_BATCH_REJECTION_CODE) return null;
  const details = attempt.terminalError.details;
  const kind = details?.kind;
  if (!isConfirmedBatchRejectionKind(kind)) return null;
  const observedQuoteIds = details?.observedQuoteIds;
  return {
    kind,
    observedQuoteIds: Array.isArray(observedQuoteIds)
      ? observedQuoteIds.filter((quoteId): quoteId is string => typeof quoteId === 'string')
      : [],
    capabilityUpdatedAt:
      typeof details?.capabilityUpdatedAt === 'number' ? details.capabilityUpdatedAt : undefined,
    replacementBatchLimit:
      typeof details?.replacementBatchLimit === 'number'
        ? details.replacementBatchLimit
        : undefined,
  };
}

export interface ProcessorRedemptionOptions {
  /** Force every processor turn to create at most a single-member attempt. */
  forceSingleRedemption?: boolean;
  /** Mint URLs that must use single-member processor redemption after normalization. */
  batchRedemptionDenylist?: string[];
}

const activeCoordinations = new WeakMap<Repositories, Map<string, Promise<MintOperation>>>();
const activeAttemptDispatches = new WeakMap<Repositories, Map<string, Promise<void>>>();

function isTerminalAttempt(attempt: MintIssuanceAttempt): boolean {
  return (
    attempt.state === 'succeeded' || attempt.state === 'rejected' || attempt.state === 'failed'
  );
}

/**
 * Internal issuance boundary for durable single and future batched mint redemption.
 *
 * It intentionally depends only on lower-level services and repositories. Public APIs and the
 * background processor reach it through MintOperationService.
 */
export class MintIssuanceCoordinator {
  private readonly repositories: Repositories;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly mintHandlerProvider?: MintHandlerProvider;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly mintScopedLock: MintScopedLock;
  private readonly nut29BatchLimitCache: Nut29BatchLimitCache;
  private readonly mintQuotePollingChecker?: MintQuotePollingChecker;
  private readonly scheduledOperationIds = new Set<string>();
  private readonly scheduledNotBefore = new Map<string, number>();
  private readonly singleFallbackOperationIds = new Set<string>();
  private readonly incompatibleRedemptionGroups = new Set<string>();
  private readonly activeByOperationId: Map<string, Promise<MintOperation>>;
  private readonly activeByAttemptId: Map<string, Promise<void>>;
  private forceSingleRedemption = false;
  private batchRedemptionDenylist = new Set<string>();
  private lastSelectedGroupKey?: string;
  private lastProcessorSelection = new Set<string>();

  constructor(options: MintIssuanceCoordinatorOptions) {
    this.repositories = options.repositories;
    const sharedActive = activeCoordinations.get(options.repositories) ?? new Map();
    activeCoordinations.set(options.repositories, sharedActive);
    this.activeByOperationId = sharedActive;
    const sharedAttemptDispatches = activeAttemptDispatches.get(options.repositories) ?? new Map();
    activeAttemptDispatches.set(options.repositories, sharedAttemptDispatches);
    this.activeByAttemptId = sharedAttemptDispatches;
    this.proofService = options.proofService;
    this.mintService = options.mintService;
    this.walletService = options.walletService;
    this.mintAdapter = options.mintAdapter;
    this.mintHandlerProvider = options.mintHandlerProvider;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.mintScopedLock = options.mintScopedLock ?? new MintScopedLock();
    this.nut29BatchLimitCache = options.nut29BatchLimitCache ?? new Nut29BatchLimitCache();
    this.mintQuotePollingChecker = options.mintQuotePollingChecker;
  }

  /** Adds a Mint Operation to the ephemeral processor-ready pool. */
  schedule(operationId: string, notBefore = 0): void {
    this.scheduledOperationIds.add(operationId);
    const existing = this.scheduledNotBefore.get(operationId);
    this.scheduledNotBefore.set(
      operationId,
      existing === undefined ? notBefore : Math.min(existing, notBefore),
    );
  }

  /** Replaces the processor redemption policy, normalizing configured mint URLs once. */
  configureProcessorRedemption(options?: ProcessorRedemptionOptions): void {
    this.forceSingleRedemption = options?.forceSingleRedemption ?? false;
    this.batchRedemptionDenylist = new Set(
      (options?.batchRedemptionDenylist ?? []).map((mintUrl) => normalizeMintUrl(mintUrl)),
    );
  }

  coordinate(): Promise<void>;
  coordinate(operationId: string): Promise<MintOperation>;
  coordinate(operationId?: string): Promise<void> | Promise<MintOperation> {
    if (operationId === undefined) {
      return this.coordinateScheduled();
    }

    const active = this.activeByOperationId.get(operationId);
    if (active) return active;

    const coordination = this.coordinateTarget(operationId).finally(() => {
      if (this.activeByOperationId.get(operationId) === coordination) {
        this.activeByOperationId.delete(operationId);
      }
    });
    this.activeByOperationId.set(operationId, coordination);
    return coordination;
  }

  isCoordinating(operationId: string): boolean {
    return this.activeByOperationId.has(operationId);
  }

  /** Returns whether a Mint Operation remains in the ephemeral processor-ready pool. */
  isScheduled(operationId: string): boolean {
    return this.scheduledOperationIds.has(operationId);
  }

  /** Returns whether the last processor turn selected a Mint Operation for coordination. */
  wasSelectedInLastProcessorTurn(operationId: string): boolean {
    return this.lastProcessorSelection.has(operationId);
  }

  /** Returns whether the current attempt can safely make progress through coordinate(). */
  async canRetry(operationId: string): Promise<boolean> {
    const operation = await this.repositories.mintOperationRepository.getById(operationId);
    if (!operation || isTerminalOperation(operation)) return false;
    if (operation.state !== 'executing' || !operation.attemptId) return false;

    const attempt = await this.repositories.mintIssuanceAttemptRepository.getById(
      operation.attemptId,
    );
    if (!attempt) return false;
    if (this.isConfirmedBatchRejection(attempt)) return true;
    if (isTerminalAttempt(attempt)) return false;
    return true;
  }

  private async coordinateScheduled(): Promise<void> {
    this.lastProcessorSelection.clear();
    const scheduled = (
      await Promise.all(
        [...this.scheduledOperationIds]
          .filter((operationId) => (this.scheduledNotBefore.get(operationId) ?? 0) <= Date.now())
          .map(async (operationId) => ({
            operationId,
            operation: await this.repositories.mintOperationRepository.getById(operationId),
          })),
      )
    ).sort((left, right) => {
      const leftOperation = left.operation;
      const rightOperation = right.operation;
      if (!leftOperation || !rightOperation)
        return left.operationId.localeCompare(right.operationId);
      return (
        leftOperation.createdAt - rightOperation.createdAt ||
        leftOperation.id.localeCompare(rightOperation.id)
      );
    });

    let deferredRejectedOperationId: string | undefined;
    for (const { operationId, operation } of scheduled) {
      if (!operation || isTerminalOperation(operation)) {
        this.unschedule(operationId);
        continue;
      }
      if (operation.attemptId) {
        const attempt = await this.repositories.mintIssuanceAttemptRepository.getById(
          operation.attemptId,
        );
        if (attempt && this.isConfirmedBatchRejection(attempt)) {
          deferredRejectedOperationId ??= operationId;
          continue;
        }
        this.lastProcessorSelection.add(operationId);
        this.unschedule(operationId);
        await this.coordinate(operationId);
        return;
      }
    }

    const candidates: PendingMintOperationRecord<'bolt11'>[] = [];
    for (const { operationId, operation } of scheduled) {
      if (
        !operation ||
        operation.state !== 'pending' ||
        operation.method !== 'bolt11' ||
        operation.attemptId
      ) {
        continue;
      }
      const quote = await this.repositories.mintQuoteRepository.getMintQuote(
        normalizeMintUrl(operation.mintUrl),
        'bolt11',
        operation.quoteId,
      );
      const bolt11Operation = operation as PendingMintOperationRecord<'bolt11'>;
      if (!this.isEligibleProcessorCandidate(bolt11Operation, quote)) {
        this.unschedule(operationId);
        continue;
      }
      candidates.push(bolt11Operation);
    }
    if (candidates.length === 0) {
      if (deferredRejectedOperationId) {
        this.lastProcessorSelection.add(deferredRejectedOperationId);
        this.unschedule(deferredRejectedOperationId);
        await this.coordinate(deferredRejectedOperationId);
      }
      return;
    }

    const groups = new Map<string, PendingMintOperationRecord<'bolt11'>[]>();
    for (const candidate of candidates) {
      const groupKey = this.processorGroupKey(candidate);
      const group = groups.get(groupKey) ?? [];
      group.push(candidate);
      groups.set(groupKey, group);
    }
    const groupKeys = [...groups.keys()].sort();
    const groupKey = this.selectNextGroupKey(groupKeys);
    const group = groups.get(groupKey)!;
    group.sort(
      (left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id),
    );
    this.lastProcessorSelection = new Set(group.map((operation) => operation.id));
    await this.restoreConfirmedRejectionPolicies(group);

    const forcedSingle = group.find((operation) =>
      this.singleFallbackOperationIds.has(operation.id),
    );
    const selectionPool = forcedSingle ? [forcedSingle] : group;
    const limit = forcedSingle ? 1 : await this.getProcessorBatchLimit(group[0]!.mintUrl);
    const uniqueQuoteIds = new Set<string>();
    const selected = selectionPool
      .filter((operation) => {
        if (uniqueQuoteIds.has(operation.quoteId)) return false;
        uniqueQuoteIds.add(operation.quoteId);
        return true;
      })
      .slice(0, limit);
    this.lastProcessorSelection = new Set(selected.map((operation) => operation.id));
    const created = await this.createBolt11Attempt(selected, selected.length > 1 && !forcedSingle);
    if (!created.newlyCreated) {
      this.lastProcessorSelection = new Set([created.operationId]);
      this.unschedule(created.operationId);
      await this.coordinate(created.operationId);
      return;
    }
    this.lastProcessorSelection = new Set(created.operations.map((operation) => operation.id));
    for (const operation of created.operations) {
      this.singleFallbackOperationIds.delete(operation.id);
      this.unschedule(operation.id);
    }

    let startDispatch!: () => void;
    const dispatchGate = new Promise<void>((resolve) => {
      startDispatch = resolve;
    });
    const dispatch = this.runAttemptDispatch(
      created.attempt.id,
      created.operations[0]!.id,
      async () => {
        await dispatchGate;
        if (created.operations.length === 1) {
          await this.performSingleAttempt(created.attempt, created.operations[0]!);
        } else {
          await this.performBatchAttempt(created.attempt, created.operations);
        }
      },
    );
    const joins = new Map<string, Promise<MintOperation>>();
    for (const operation of created.operations) {
      const join = dispatch.then(async () => {
        const completed = await this.requireOperation(operation.id);
        return toMintOperation(completed);
      });
      void join.catch(() => undefined);
      joins.set(operation.id, join);
      this.activeByOperationId.set(operation.id, join);
    }

    try {
      await this.emitAttemptPrepared(created);
      startDispatch();
      await dispatch;
    } finally {
      startDispatch();
      for (const [operationId, join] of joins) {
        if (this.activeByOperationId.get(operationId) === join) {
          this.activeByOperationId.delete(operationId);
        }
      }
    }
  }

  private processorGroupKey(operation: PendingMintOperationRecord<'bolt11'>): string {
    return `${normalizeMintUrl(operation.mintUrl)}::bolt11::${operation.unit}`;
  }

  private async restoreConfirmedRejectionPolicies(
    operations: PendingMintOperationRecord<'bolt11'>[],
  ): Promise<void> {
    const mintUrl = normalizeMintUrl(operations[0]!.mintUrl);
    const groupKey = mintQuoteGroupKey(mintUrl, 'bolt11');
    this.incompatibleRedemptionGroups.delete(groupKey);
    const [mint, mintAttempts] = await Promise.all([
      this.repositories.mintRepository.getMintByUrl(mintUrl),
      this.repositories.mintIssuanceAttemptRepository.listByMintUrl(mintUrl),
    ]);

    for (const attempt of mintAttempts) {
      if (attempt.method !== 'bolt11' || attempt.state !== 'rejected') continue;
      const progress = getConfirmedBatchRejectionProgress(attempt);
      if (!progress || progress.kind === 'validation') continue;
      const capabilityHasRefreshed =
        mint !== null &&
        progress.capabilityUpdatedAt !== undefined &&
        mint.updatedAt > progress.capabilityUpdatedAt;
      if (capabilityHasRefreshed) continue;
      if (progress.kind === 'incompatibility') {
        this.incompatibleRedemptionGroups.add(groupKey);
      } else if (progress.replacementBatchLimit !== undefined) {
        this.nut29BatchLimitCache.lower(groupKey, progress.replacementBatchLimit);
      }
    }

    for (const operation of operations) {
      this.singleFallbackOperationIds.delete(operation.id);
      const previousAttempt =
        await this.repositories.mintIssuanceAttemptRepository.getByMemberOperationId(operation.id);
      if (!previousAttempt || previousAttempt.state !== 'rejected') continue;
      const progress = getConfirmedBatchRejectionProgress(previousAttempt);
      if (!progress) continue;

      if (progress.kind === 'validation') {
        this.singleFallbackOperationIds.add(operation.id);
      }
    }
  }

  /** Removes a Mint Operation from the ephemeral processor-ready pool. */
  unschedule(operationId: string): void {
    this.scheduledOperationIds.delete(operationId);
    this.scheduledNotBefore.delete(operationId);
  }

  private selectNextGroupKey(groupKeys: string[]): string {
    let selected = groupKeys[0]!;
    if (this.lastSelectedGroupKey) {
      selected = groupKeys.find((groupKey) => groupKey > this.lastSelectedGroupKey!) ?? selected;
    }
    this.lastSelectedGroupKey = selected;
    return selected;
  }

  private async getProcessorBatchLimit(mintUrl: string): Promise<number> {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const groupKey = mintQuoteGroupKey(normalizedMintUrl, 'bolt11');
    if (
      this.forceSingleRedemption ||
      this.batchRedemptionDenylist.has(normalizedMintUrl) ||
      this.incompatibleRedemptionGroups.has(groupKey) ||
      !(await this.mintService.isTrustedMint(normalizedMintUrl))
    ) {
      return 1;
    }
    const mintInfo = await this.mintService.getMintInfo(normalizedMintUrl);
    const advertisedLimit = getNut29MintQuoteCheckLimit(mintInfo, 'bolt11') ?? 1;
    return this.nut29BatchLimitCache.get(groupKey, advertisedLimit);
  }

  private isEligibleProcessorCandidate(
    operation: PendingMintOperationRecord<'bolt11'>,
    quote: MintQuote | null,
  ): quote is MintQuote<'bolt11'> {
    if (!quote || quote.method !== 'bolt11' || quote.pubkey) return false;
    if (quote.reusable || getMintQuoteRemoteState(quote) !== 'PAID') return false;
    const amount = getMintQuoteAmount(quote);
    return Boolean(amount?.equals(operation.amount) && quote.unit === operation.unit);
  }

  private async coordinateTarget(operationId: string): Promise<MintOperation> {
    let operation = await this.requireOperation(operationId);
    if (isTerminalOperation(operation)) return toMintOperation(operation);

    let attempt = operation.attemptId
      ? await this.repositories.mintIssuanceAttemptRepository.getById(operation.attemptId)
      : null;

    if (!attempt) {
      if (operation.state !== 'pending') {
        throw new Error(`Executing mint operation ${operation.id} is missing its issuance attempt`);
      }
      const created = await this.createSingleBolt11Attempt(operation);
      attempt = created.attempt;
      if (created.newlyCreated) {
        operation = created.operations[0]!;
        await this.emitAttemptPrepared(created);
      } else {
        operation = await this.requireOperation(operationId);
      }
    }

    if (!attempt.memberOperationIds.includes(operationId)) {
      throw new Error(
        `Mint issuance attempt ${attempt.id} does not contain operation ${operationId}`,
      );
    }

    switch (attempt.state) {
      case 'prepared': {
        if (attempt.request.kind === 'batch') {
          const members = await this.requireExecutingBolt11Members(attempt);
          return this.dispatchBatchAttempt(attempt, members, operationId);
        }
        return this.dispatchSingleAttempt(attempt, operation);
      }
      case 'submitting':
      case 'recovering':
        if (attempt.request.kind === 'batch') {
          if (this.isConfirmedBatchRejection(attempt)) {
            const members = await this.requireExecutingBolt11Members(attempt);
            return this.reconcileConfirmedBatchRejection(attempt, members, operationId);
          }
          const members = await this.requireExecutingBolt11Members(attempt);
          return this.reconcileBatchAttempt(attempt, members, operationId);
        }
        return this.reconcileSingleAttempt(attempt, operation);
      case 'succeeded': {
        const completed = await this.requireOperation(operationId);
        if (!isTerminalOperation(completed)) {
          throw new Error(
            `Succeeded attempt ${attempt.id} has non-terminal operation ${operationId}`,
          );
        }
        return toMintOperation(completed);
      }
      case 'rejected': {
        if (
          this.isConfirmedBatchRejection(attempt) &&
          operation.state === 'executing' &&
          operation.attemptId === attempt.id
        ) {
          const members = await this.getUnreconciledBolt11Members(attempt);
          return this.reconcileConfirmedBatchRejection(attempt, members, operationId);
        }
        const completed = await this.requireOperation(operationId);
        if (isTerminalOperation(completed)) return toMintOperation(completed);
        throw new Error(`Rejected attempt ${attempt.id} has non-terminal operation ${operationId}`);
      }
      case 'failed': {
        const completed = await this.requireOperation(operationId);
        if (isTerminalOperation(completed)) return toMintOperation(completed);
        throw new Error(`Terminal attempt ${attempt.id} has non-terminal operation ${operationId}`);
      }
    }
  }

  private async createSingleBolt11Attempt(
    candidate: PendingMintOperationRecord,
  ): Promise<CreatedAttempt> {
    if (candidate.method !== 'bolt11') {
      throw new Error(`Single issuance attempts currently support BOLT11, not ${candidate.method}`);
    }

    return this.createBolt11Attempt([candidate as PendingMintOperationRecord<'bolt11'>], false);
  }

  private async createBolt11Attempt(
    candidates: PendingMintOperationRecord<'bolt11'>[],
    allowBatch: boolean,
  ): Promise<CreatedAttempt> {
    if (candidates.length === 0) throw new Error('Mint issuance cohort must not be empty');

    const mintUrl = normalizeMintUrl(candidates[0]!.mintUrl);
    const releaseMintLock = await this.mintScopedLock.acquire(mintUrl);
    try {
      let currentCandidates = await Promise.all(
        candidates.map((candidate) => this.requireOperation(candidate.id)),
      );
      const attached = currentCandidates.find((candidate) => candidate.attemptId);
      if (attached?.attemptId) {
        const attempt = await this.repositories.mintIssuanceAttemptRepository.getById(
          attached.attemptId,
        );
        if (!attempt || attached.method !== 'bolt11') {
          throw new Error(`Operation ${attached.id} has an invalid issuance attempt attachment`);
        }
        return {
          attempt,
          operationId: attached.id,
          newlyCreated: false,
        };
      }
      if (
        currentCandidates.some(
          (candidate) => candidate.state !== 'pending' || candidate.method !== 'bolt11',
        )
      ) {
        throw new Error('Cannot create a BOLT11 issuance attempt from an ineligible operation');
      }

      if (!(await this.mintService.isTrustedMint(mintUrl))) {
        throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
      }
      let revalidatedLimit = 1;
      const groupKey = mintQuoteGroupKey(mintUrl, 'bolt11');
      if (
        allowBatch &&
        !this.forceSingleRedemption &&
        !this.batchRedemptionDenylist.has(mintUrl) &&
        !this.incompatibleRedemptionGroups.has(groupKey)
      ) {
        const mintInfo = await this.mintService.getMintInfo(mintUrl);
        const advertisedLimit = supportsNut29MintQuoteCheck(mintInfo, 'bolt11')
          ? (getNut29MintQuoteCheckLimit(mintInfo, 'bolt11') ?? 1)
          : 1;
        revalidatedLimit = this.nut29BatchLimitCache.get(groupKey, advertisedLimit);
      }
      currentCandidates = currentCandidates.slice(0, revalidatedLimit);
      const first = currentCandidates[0]! as PendingMintOperationRecord<'bolt11'>;
      if (
        currentCandidates.some(
          (candidate) =>
            normalizeMintUrl(candidate.mintUrl) !== mintUrl ||
            candidate.method !== 'bolt11' ||
            candidate.unit !== first.unit,
        )
      ) {
        throw new Error('Mint issuance cohort must share mint, method, and unit');
      }
      await this.mintService.assertMethodUnitSupported(mintUrl, 4, 'bolt11', {
        amount: first.amount,
        unit: first.unit,
      });
      const { keysetId } = await this.walletService.getWalletWithActiveKeysetId(
        mintUrl,
        first.unit,
      );
      const storedCounter = await this.repositories.counterRepository.getCounter(mintUrl, keysetId);
      const counterStart = storedCounter?.counter ?? 0;
      const quotes = await Promise.all(
        currentCandidates.map(async (candidate) => {
          const quote = await this.repositories.mintQuoteRepository.getMintQuote(
            mintUrl,
            'bolt11',
            candidate.quoteId,
          );
          this.assertEligibleSingleQuote(candidate as PendingMintOperationRecord<'bolt11'>, quote);
          if (currentCandidates.length > 1 && quote.pubkey) {
            throw new Error(`Mint quote ${quote.quoteId} requires NUT-20 signing`);
          }
          return quote;
        }),
      );
      const quoteAmounts = quotes.map((quote) => getMintQuoteAmount(quote)!);
      const totalAmount = quoteAmounts
        .slice(1)
        .reduce((total, amount) => total.add(amount), quoteAmounts[0]!);
      const outputs = await this.proofService.createMintOutputsAtCounter(
        mintUrl,
        { amount: totalAmount, unit: first.unit },
        counterStart,
      );
      if (outputs.keysetId !== keysetId || outputs.counterStart !== counterStart) {
        throw new Error(
          'Active keyset or deterministic counter changed during attempt construction',
        );
      }
      const attemptId = generateSubId();
      const created = await this.repositories.withTransaction(async (tx) => {
        const operations = await Promise.all(
          currentCandidates.map((candidate) => tx.mintOperationRepository.getById(candidate.id)),
        );
        if (operations.some((operation) => !operation)) {
          throw new Error('A Mint Operation disappeared before attempt creation');
        }
        if (!(await tx.mintRepository.isTrustedMint(mintUrl))) {
          throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
        }
        if (currentCandidates.length > 1) {
          const currentMint = await tx.mintRepository.getMintByUrl(mintUrl);
          const advertisedLimit = supportsNut29MintQuoteCheck(currentMint.mintInfo, 'bolt11')
            ? (getNut29MintQuoteCheckLimit(currentMint.mintInfo, 'bolt11') ?? 1)
            : 1;
          const currentLimit = this.nut29BatchLimitCache.get(
            mintQuoteGroupKey(mintUrl, 'bolt11'),
            advertisedLimit,
          );
          if (currentCandidates.length > currentLimit) {
            throw new Error('Mint NUT-29 capability changed before attempt creation committed');
          }
        }

        const bolt11Operations = operations.map((operation) => {
          if (
            !operation ||
            operation.state !== 'pending' ||
            operation.method !== 'bolt11' ||
            operation.attemptId
          ) {
            throw new Error('A Mint Operation is no longer eligible for issuance');
          }
          return operation as PendingMintOperationRecord<'bolt11'>;
        });
        for (const [index, operation] of bolt11Operations.entries()) {
          const quote = await tx.mintQuoteRepository.getMintQuote(
            mintUrl,
            'bolt11',
            operation.quoteId,
          );
          this.assertEligibleSingleQuote(operation, quote);
          if (!getMintQuoteAmount(quote!)?.equals(quoteAmounts[index]!)) {
            throw new Error(`Mint quote ${operation.quoteId} changed before attempt creation`);
          }
          if (bolt11Operations.length > 1 && quote.pubkey) {
            throw new Error(`Mint quote ${quote.quoteId} requires NUT-20 signing`);
          }
        }

        const transactionCounter = await tx.counterRepository.getCounter(mintUrl, keysetId);
        if ((transactionCounter?.counter ?? 0) !== counterStart) {
          throw new Error('Deterministic counter changed before attempt creation committed');
        }

        const now = Date.now();
        const attempt: MintIssuanceAttempt = {
          id: attemptId,
          mintUrl,
          method: 'bolt11',
          unit: first.unit,
          keysetId,
          state: 'prepared',
          memberOperationIds: bolt11Operations.map((operation) => operation.id),
          quoteIds: bolt11Operations.map((operation) => operation.quoteId),
          quoteAmounts,
          signingRequirements: bolt11Operations.map(() => null),
          outputData: outputs.outputData,
          counterStart,
          counterEnd: outputs.counterEnd,
          request:
            bolt11Operations.length === 1
              ? { kind: 'single', quoteId: bolt11Operations[0]!.quoteId }
              : {
                  kind: 'batch',
                  quoteIds: bolt11Operations.map((operation) => operation.quoteId),
                  quoteAmounts,
                },
          createdAt: now,
          updatedAt: now,
        };
        const executing = bolt11Operations.map(
          (operation): ExecutingMintOperationRecord<'bolt11'> => ({
            ...operation,
            state: 'executing',
            attemptId,
            outputData: outputs.outputData,
            error: undefined,
            updatedAt: now,
          }),
        );

        await tx.mintIssuanceAttemptRepository.create(attempt);
        for (const operation of executing) {
          await tx.mintOperationRepository.update(operation);
        }
        await tx.counterRepository.setCounter(mintUrl, keysetId, outputs.counterEnd);
        return { attempt, operations: executing, newlyCreated: true as const };
      });

      await this.eventBus.emit('counter:updated', {
        mintUrl,
        keysetId,
        counter: created.attempt.counterEnd!,
      });
      return created;
    } finally {
      releaseMintLock();
    }
  }

  private async emitAttemptPrepared(
    created: Extract<CreatedAttempt, { newlyCreated: true }>,
  ): Promise<void> {
    for (const operation of created.operations) {
      await this.eventBus.emit('mint-op:executing', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    this.logger?.info('Mint issuance attempt prepared', {
      attemptId: created.attempt.id,
      memberOperationIds: created.attempt.memberOperationIds,
      mintUrl: created.attempt.mintUrl,
      method: 'bolt11',
      unit: created.attempt.unit,
    });
  }

  private async requireExecutingBolt11Members(
    attempt: MintIssuanceAttempt,
  ): Promise<ExecutingMintOperationRecord<'bolt11'>[]> {
    const operations = await Promise.all(
      attempt.memberOperationIds.map((operationId) => this.requireOperation(operationId)),
    );
    return operations.map((operation) => {
      if (
        operation.state !== 'executing' ||
        operation.method !== 'bolt11' ||
        operation.attemptId !== attempt.id
      ) {
        throw new Error(`Operation ${operation.id} no longer belongs to attempt ${attempt.id}`);
      }
      return operation as ExecutingMintOperationRecord<'bolt11'>;
    });
  }

  private async getUnreconciledBolt11Members(
    attempt: MintIssuanceAttempt,
  ): Promise<ExecutingMintOperationRecord<'bolt11'>[]> {
    const operations = await Promise.all(
      attempt.memberOperationIds.map((operationId) => this.requireOperation(operationId)),
    );
    return operations.filter(
      (operation): operation is ExecutingMintOperationRecord<'bolt11'> =>
        operation.state === 'executing' &&
        operation.method === 'bolt11' &&
        operation.attemptId === attempt.id,
    );
  }

  private assertEligibleSingleQuote(
    operation: PendingMintOperationRecord<'bolt11'>,
    quote: MintQuote | null,
  ): asserts quote is MintQuote<'bolt11'> {
    if (!quote || quote.method !== 'bolt11') {
      throw new Error(`Mint quote ${operation.quoteId} was not found for BOLT11 issuance`);
    }
    if (quote.reusable || getMintQuoteRemoteState(quote) !== 'PAID') {
      throw new Error(`Mint quote ${operation.quoteId} is not eligible for single issuance`);
    }
    const quoteAmount = getMintQuoteAmount(quote);
    if (!quoteAmount?.equals(operation.amount) || quote.unit !== operation.unit) {
      throw new Error(
        `Mint quote ${operation.quoteId} no longer matches operation ${operation.id}`,
      );
    }
  }

  private async markSubmitting(attempt: MintIssuanceAttempt): Promise<MintIssuanceAttempt> {
    return this.repositories.withTransaction(async (tx) => {
      const current = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!current) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      if (isTerminalAttempt(current)) return current;
      const now = Date.now();
      const submitting: MintIssuanceAttempt = {
        ...current,
        state: 'submitting',
        submittedAt: current.submittedAt ?? now,
        updatedAt: now,
      };
      await tx.mintIssuanceAttemptRepository.update(submitting);
      return submitting;
    });
  }

  private async dispatchSingleAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    return this.runAttemptDispatch(attempt.id, operation.id, async () => {
      await this.performSingleAttempt(attempt, operation);
    });
  }

  private async performSingleAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    if (operation.method !== 'bolt11') {
      return this.dispatchLegacyMethodAttempt(attempt, operation);
    }
    if (operation.state !== 'executing' || operation.method !== 'bolt11') {
      throw new Error(`Attempt ${attempt.id} does not have one executing BOLT11 operation`);
    }
    const executing = operation as ExecutingMintOperationRecord<'bolt11'>;

    const submitting = await this.markSubmitting(attempt);
    if (isTerminalAttempt(submitting)) {
      return this.requireTerminalOperation(operation.id, submitting.id);
    }

    const outputData = deserializeOutputData(attempt.outputData);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      attempt.mintUrl,
      attempt.unit,
    );
    try {
      const proofs = await wallet.mintProofsBolt11(
        executing.amount,
        executing.quoteId,
        { keysetId: attempt.keysetId },
        {
          type: 'custom',
          data: outputData.keep,
        },
      );
      this.assertExactProofSet(attempt, proofs);
      return await this.completeAttempt(attempt, executing, proofs, false);
    } catch (error) {
      const recovering = await this.markRecovering(submitting, error);
      if (isTerminalAttempt(recovering)) {
        return this.requireTerminalOperation(operation.id, recovering.id);
      }
      if (error instanceof MintOperationError && error.code === 20002) {
        return this.reconcileSingleAttempt(recovering, executing);
      }
      throw error;
    }
  }

  private classifyConfirmedBatchRejection(error: unknown): ConfirmedBatchRejection | null {
    if (error instanceof HttpResponseError && INCOMPATIBLE_ENDPOINT_STATUSES.has(error.status)) {
      return { kind: 'incompatibility', error, httpStatus: error.status };
    }
    if (!(error instanceof MintOperationError) || error.code >= AUTHENTICATION_ERROR_CODE_MIN) {
      return null;
    }
    if (error.code === NUT29_BATCH_SIZE_ERROR_CODE) {
      return { kind: 'batch-size', error, protocolCode: error.code };
    }
    if (MINT_QUOTE_STATE_ERROR_CODES.has(error.code)) {
      return { kind: 'state', error, protocolCode: error.code };
    }
    return { kind: 'validation', error, protocolCode: error.code };
  }

  private isConfirmedBatchRejection(attempt: MintIssuanceAttempt): boolean {
    return getConfirmedBatchRejectionProgress(attempt) !== null;
  }

  private async markConfirmedBatchRejection(
    attempt: MintIssuanceAttempt,
    rejection: ConfirmedBatchRejection,
  ): Promise<MintIssuanceAttempt> {
    return this.repositories.withTransaction(async (tx) => {
      const current = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!current) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      if (isTerminalAttempt(current)) return current;
      const mint = await tx.mintRepository.getMintByUrl(current.mintUrl);
      const now = Date.now();
      const rejected: MintIssuanceAttempt = {
        ...current,
        state: 'rejected',
        recoveryStartedAt: current.recoveryStartedAt ?? now,
        updatedAt: now,
        terminalError: {
          message: rejection.error.message,
          code: CONFIRMED_BATCH_REJECTION_CODE,
          details: {
            kind: rejection.kind,
            protocolCode: rejection.protocolCode,
            httpStatus: rejection.httpStatus,
            observedQuoteIds: [],
            capabilityUpdatedAt: mint?.updatedAt,
            replacementBatchLimit:
              rejection.kind === 'batch-size'
                ? Math.max(1, Math.floor(current.memberOperationIds.length / 2))
                : undefined,
          },
        },
      };
      await tx.mintIssuanceAttemptRepository.update(rejected);
      return rejected;
    });
  }

  /**
   * Reconciles only conclusively unissued batches. Canonical quote observations commit before any
   * member advances; the attempt is already terminal before any observed member is requeued; and
   * missing members remain attached for later checks without blocking fresh-output replacements.
   */
  private async reconcileConfirmedBatchRejection(
    attempt: MintIssuanceAttempt,
    operations: ExecutingMintOperationRecord<'bolt11'>[],
    targetOperationId: string,
  ): Promise<MintOperation> {
    const progress = getConfirmedBatchRejectionProgress(attempt);
    if (!progress) throw new Error(`Mint Batch ${attempt.id} lost its rejection classification`);
    const { kind } = progress;
    const observedQuoteIds = new Set(progress.observedQuoteIds);
    const unreconciledQuoteIds = attempt.quoteIds.filter(
      (quoteId) => !observedQuoteIds.has(quoteId),
    );
    const newlyObservedQuoteIds = new Set<string>();
    if (kind === 'state' || kind === 'validation') {
      if (!this.mintQuotePollingChecker) {
        throw new Error(`Mint Batch ${attempt.id} cannot recheck its canonical quotes`);
      }
      const result = await this.mintQuotePollingChecker.checkMintQuotesForPolling(
        attempt.mintUrl,
        'bolt11',
        unreconciledQuoteIds,
      );
      for (const observation of result.observations) {
        if (unreconciledQuoteIds.includes(observation.quote)) {
          newlyObservedQuoteIds.add(observation.quote);
        }
      }
    } else {
      for (const quoteId of unreconciledQuoteIds) newlyObservedQuoteIds.add(quoteId);
    }
    if (newlyObservedQuoteIds.size === 0) {
      return toMintOperation(await this.requireOperation(targetOperationId));
    }

    const quotesById = new Map<string, MintQuote<'bolt11'>>();
    for (const quoteId of newlyObservedQuoteIds) {
      const quote = await this.repositories.mintQuoteRepository.getMintQuote(
        attempt.mintUrl,
        'bolt11',
        quoteId,
      );
      if (!quote || quote.method !== 'bolt11') {
        throw new Error(`Mint Batch ${attempt.id} lost canonical quote ${quoteId}`);
      }
      quotesById.set(quoteId, quote);
    }

    const now = Date.now();
    const reconciled = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!currentAttempt) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      const currentProgress = getConfirmedBatchRejectionProgress(currentAttempt);
      if (!currentProgress) {
        throw new Error(`Mint Batch ${attempt.id} lost its rejection classification`);
      }
      const currentObservedQuoteIds = new Set(currentProgress.observedQuoteIds);
      const pendingOperations: PendingMintOperationRecord<'bolt11'>[] = [];
      const failedOperations: FailedMintOperationRecord<'bolt11'>[] = [];
      for (const operation of operations) {
        const memberIndex = attempt.memberOperationIds.indexOf(operation.id);
        const quoteId = attempt.quoteIds[memberIndex];
        if (!quoteId || !newlyObservedQuoteIds.has(quoteId)) continue;
        const current = await tx.mintOperationRepository.getById(operation.id);
        if (
          !current ||
          current.state !== 'executing' ||
          current.method !== 'bolt11' ||
          current.attemptId !== attempt.id
        ) {
          currentObservedQuoteIds.add(quoteId);
          continue;
        }
        const executing = current as ExecutingMintOperationRecord<'bolt11'>;
        const quote = quotesById.get(quoteId)!;
        const remoteState = getMintQuoteRemoteState(quote);
        if (remoteState === 'PAID' || (remoteState === 'UNPAID' && !isMintQuoteExpired(quote))) {
          const pending: PendingMintOperationRecord<'bolt11'> = {
            ...executing,
            state: 'pending',
            attemptId: undefined,
            outputData: serializeOutputData({ keep: [], send: [] }),
            error: undefined,
            terminalFailure: undefined,
            updatedAt: now,
          };
          await tx.mintOperationRepository.update(pending);
          pendingOperations.push(pending);
          currentObservedQuoteIds.add(quoteId);
          continue;
        }

        const error =
          remoteState === 'ISSUED'
            ? `Mint quote ${current.quoteId} was issued but its exact proofs could not be recovered`
            : `Mint quote ${current.quoteId} expired before issuance`;
        const failed: FailedMintOperationRecord<'bolt11'> = {
          ...executing,
          state: 'failed',
          attemptId: attempt.id,
          outputData: attempt.outputData,
          error,
          terminalFailure: { reason: error, observedAt: now },
          updatedAt: now,
        };
        await tx.mintOperationRepository.update(failed);
        failedOperations.push(failed);
        currentObservedQuoteIds.add(quoteId);
      }
      const rejectionReconciled = currentObservedQuoteIds.size === attempt.quoteIds.length;
      const updatedAttempt: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'rejected',
        updatedAt: now,
        recoveredAt: rejectionReconciled ? now : currentAttempt.recoveredAt,
        terminalError: {
          ...currentAttempt.terminalError!,
          details: {
            ...currentAttempt.terminalError?.details,
            observedQuoteIds: attempt.quoteIds.filter((quoteId) =>
              currentObservedQuoteIds.has(quoteId),
            ),
          },
        },
      };
      await tx.mintIssuanceAttemptRepository.update(updatedAttempt);
      return { pendingOperations, failedOperations };
    });
    const groupKey = mintQuoteGroupKey(attempt.mintUrl, 'bolt11');
    if (kind === 'batch-size' && progress.replacementBatchLimit !== undefined) {
      this.nut29BatchLimitCache.lower(groupKey, progress.replacementBatchLimit);
    }
    if (kind === 'incompatibility') {
      this.incompatibleRedemptionGroups.add(groupKey);
    }
    if (kind === 'validation') {
      for (const operation of reconciled.pendingOperations) {
        this.singleFallbackOperationIds.add(operation.id);
      }
    }
    for (const operation of reconciled.pendingOperations) {
      this.schedule(operation.id);
      await this.eventBus.emit('mint-op:requeue', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    for (const operation of reconciled.failedOperations) {
      await this.eventBus.emit('mint-op:failed', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    return toMintOperation(await this.requireOperation(targetOperationId));
  }

  private async dispatchBatchAttempt(
    attempt: MintIssuanceAttempt,
    operations: ExecutingMintOperationRecord<'bolt11'>[],
    targetOperationId = operations[0]!.id,
  ): Promise<MintOperation> {
    return this.runAttemptDispatch(attempt.id, targetOperationId, async () => {
      await this.performBatchAttempt(attempt, operations, targetOperationId);
    });
  }

  private async performBatchAttempt(
    attempt: MintIssuanceAttempt,
    operations: ExecutingMintOperationRecord<'bolt11'>[],
    targetOperationId = operations[0]!.id,
  ): Promise<MintOperation> {
    if (attempt.request.kind !== 'batch' || operations.length < 2) {
      throw new Error(`Attempt ${attempt.id} is not a Mint Batch`);
    }
    const submitting = await this.markSubmitting(attempt);
    if (isTerminalAttempt(submitting)) {
      return this.requireTerminalOperation(targetOperationId, submitting.id);
    }

    const outputData = deserializeOutputData(attempt.outputData);
    if (outputData.send.length > 0) {
      throw new Error(`Mint Batch ${attempt.id} contains unsupported send outputs`);
    }
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      attempt.mintUrl,
      attempt.unit,
    );
    const preview: BatchMintPreview<Pick<{ quote: string }, 'quote'>> = {
      method: 'bolt11',
      payload: {
        quotes: [...attempt.request.quoteIds],
        quote_amounts: attempt.request.quoteAmounts.map((amount) => amount),
        outputs: outputData.keep.map((output) => output.blindedMessage),
      },
      outputData: outputData.keep,
      keysetId: attempt.keysetId,
      quotes: attempt.request.quoteIds.map((quote) => ({ quote })),
    };
    try {
      const proofs = await wallet.completeBatchMint(preview);
      this.assertExactProofSet(attempt, proofs);
      return this.completeBatchAttempt(attempt, operations, proofs, false, targetOperationId);
    } catch (error) {
      const rejection = this.classifyConfirmedBatchRejection(error);
      if (rejection) {
        const recovering = await this.markConfirmedBatchRejection(submitting, rejection);
        return this.reconcileConfirmedBatchRejection(recovering, operations, targetOperationId);
      }
      const recovering = await this.markRecovering(submitting, error);
      if (isTerminalAttempt(recovering)) {
        return this.requireTerminalOperation(targetOperationId, recovering.id);
      }
      throw error;
    }
  }

  private runAttemptDispatch(
    attemptId: string,
    targetOperationId: string,
    dispatch: () => Promise<void>,
  ): Promise<MintOperation> {
    let active = this.activeByAttemptId.get(attemptId);
    if (!active) {
      const started = dispatch();
      const tracked = started.finally(() => {
        if (this.activeByAttemptId.get(attemptId) === tracked) {
          this.activeByAttemptId.delete(attemptId);
        }
      });
      active = tracked;
      this.activeByAttemptId.set(attemptId, tracked);
    }
    return active.then(async () => toMintOperation(await this.requireOperation(targetOperationId)));
  }

  private async reconcileSingleAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    if (operation.method !== 'bolt11') {
      return this.reconcileLegacyMethodAttempt(attempt, operation);
    }
    if (operation.state !== 'executing' || operation.method !== 'bolt11') {
      throw new Error(`Attempt ${attempt.id} does not have one executing BOLT11 operation`);
    }
    const executing = operation as ExecutingMintOperationRecord<'bolt11'>;

    const recovering =
      attempt.state === 'recovering'
        ? attempt
        : await this.markRecovering(attempt, new Error('Recovery join started'));
    if (isTerminalAttempt(recovering)) {
      return this.requireTerminalOperation(operation.id, recovering.id);
    }
    let remoteQuote;
    try {
      remoteQuote = await this.mintAdapter.checkMintQuote(
        recovering.mintUrl,
        'bolt11',
        executing.quoteId,
      );
    } catch (error) {
      const latest = await this.markRecovering(recovering, error);
      if (isTerminalAttempt(latest)) {
        return this.requireTerminalOperation(operation.id, latest.id);
      }
      throw error;
    }
    if (remoteQuote.state === 'PAID') {
      return this.dispatchSingleAttempt(recovering, executing);
    }
    if (remoteQuote.state !== 'ISSUED') {
      const latest = await this.markRecovering(
        recovering,
        new Error(`Mint quote ${executing.quoteId} remains ${remoteQuote.state}`),
      );
      if (isTerminalAttempt(latest)) {
        return this.requireTerminalOperation(operation.id, latest.id);
      }
      throw new Error(
        `Cannot reconcile issuance attempt ${attempt.id}: quote is ${remoteQuote.state}`,
      );
    }

    const recovered = await this.proofService.recoverProofsFromOutputData(
      recovering.mintUrl,
      recovering.outputData,
      {
        unit: recovering.unit,
        createdByAttemptId: recovering.id,
        persistRecoveredProofs: false,
      },
    );
    try {
      this.assertExactProofSet(recovering, recovered);
    } catch {
      return this.failAttemptAsExternallyRedeemed(recovering, executing);
    }
    return this.completeAttempt(recovering, executing, recovered, true);
  }

  private async reconcileBatchAttempt(
    attempt: MintIssuanceAttempt,
    operations: ExecutingMintOperationRecord<'bolt11'>[],
    targetOperationId: string,
  ): Promise<MintOperation> {
    const context: BatchRecoveryContext = { attempt, operations, targetOperationId };
    return this.runAttemptDispatch(attempt.id, targetOperationId, async () => {
      await this.performBatchRecovery(context);
    });
  }

  /**
   * Reconciles one exact Mint Batch after an ambiguous remote boundary.
   *
   * The polling checker persists Attributable Quote Observations before this method reads canonical
   * rows. A complete all-PAID observation resubmits the immutable request, all-ISSUED invokes
   * NUT-09 Restore, and other complete state sets reconcile each member independently. Missing or
   * unusable observations leave the exact attempt and every member recoverable.
   */
  private async performBatchRecovery(context: BatchRecoveryContext): Promise<void> {
    const { attempt, operations, targetOperationId } = context;
    if (
      attempt.request.kind !== 'batch' ||
      operations.length !== attempt.memberOperationIds.length
    ) {
      throw new Error(`Attempt ${attempt.id} is not a complete recoverable Mint Batch`);
    }
    const recovering =
      attempt.state === 'recovering'
        ? attempt
        : await this.markRecovering(attempt, new Error('Mint Batch recovery started'));
    if (isTerminalAttempt(recovering) || !this.mintQuotePollingChecker) return;

    let result;
    try {
      result = await this.mintQuotePollingChecker.checkMintQuotesForPolling(
        recovering.mintUrl,
        'bolt11',
        recovering.quoteIds,
      );
    } catch (error) {
      await this.markRecovering(recovering, error);
      if (
        error instanceof NetworkError ||
        (error instanceof HttpResponseError && (error.status === 429 || error.status >= 500))
      ) {
        throw error;
      }
      return;
    }

    const observedQuoteIds = new Set(
      result.observations
        .map((observation) => observation.quote)
        .filter((quoteId) => recovering.quoteIds.includes(quoteId)),
    );
    if (recovering.quoteIds.some((quoteId) => !observedQuoteIds.has(quoteId))) return;

    const quotes = await Promise.all(
      recovering.quoteIds.map((quoteId) =>
        this.repositories.mintQuoteRepository.getMintQuote(recovering.mintUrl, 'bolt11', quoteId),
      ),
    );
    const bolt11Quotes = quotes.filter(
      (quote): quote is MintQuote<'bolt11'> => quote?.method === 'bolt11',
    );
    if (bolt11Quotes.length !== recovering.quoteIds.length) return;
    const states = bolt11Quotes.map((quote) => getMintQuoteRemoteState(quote));

    if (states.every((state) => state === 'PAID')) {
      await this.performBatchAttempt(recovering, operations, targetOperationId);
      return;
    }
    if (states.every((state) => state === 'ISSUED')) {
      await this.recoverIssuedBatchAttempt({ ...context, attempt: recovering });
      return;
    }
    await this.reconcileMixedBatchRecovery({ ...context, attempt: recovering }, bolt11Quotes);
  }

  private async recoverIssuedBatchAttempt(context: BatchRecoveryContext): Promise<void> {
    const { attempt, operations, targetOperationId } = context;
    let recovered: Proof[];
    try {
      recovered = await this.proofService.recoverProofsFromOutputData(
        attempt.mintUrl,
        attempt.outputData,
        {
          unit: attempt.unit,
          createdByAttemptId: attempt.id,
          persistRecoveredProofs: false,
        },
      );
    } catch (error) {
      await this.markRecovering(attempt, error);
      return;
    }

    const validProofs = this.getValidRecoveredProofs(attempt, recovered);
    if (this.matchesExactProofSet(attempt, validProofs)) {
      await this.completeBatchAttempt(attempt, operations, validProofs, true, targetOperationId);
      return;
    }
    if (recovered.length === 0) {
      await this.failBatchRecovery(
        context,
        {
          message: `Mint Batch ${attempt.id} was issued but none of its exact outputs could be recovered`,
          code: 'EXACT_PROOFS_UNRECOVERABLE',
        },
        [],
      );
      return;
    }
    if (validProofs.length === 0) {
      await this.markRecovering(
        attempt,
        new Error(`Mint Batch ${attempt.id} returned unusable recovered proofs`),
      );
      return;
    }
    await this.failBatchRecovery(
      context,
      {
        message: `Critical partial signing recovered only part of Mint Batch ${attempt.id}`,
        code: 'CRITICAL_PARTIAL_SIGNING',
      },
      validProofs,
    );
  }

  private getValidRecoveredProofs(attempt: MintIssuanceAttempt, proofs: Proof[]): Proof[] {
    const outputs = deserializeOutputData(attempt.outputData);
    const expected = new Map(
      [...outputs.keep, ...outputs.send].map((output) => [
        new TextDecoder().decode(output.secret),
        output.blindedMessage,
      ]),
    );
    const seen = new Set<string>();
    return proofs.filter((proof) => {
      const output = expected.get(proof.secret);
      if (
        !output ||
        seen.has(proof.secret) ||
        output.id !== proof.id ||
        !output.amount.equals(proof.amount)
      ) {
        return false;
      }
      seen.add(proof.secret);
      return true;
    });
  }

  private async reconcileMixedBatchRecovery(
    context: BatchRecoveryContext,
    quotes: MintQuote<'bolt11'>[],
  ): Promise<void> {
    const { attempt, operations, targetOperationId } = context;
    const now = Date.now();
    const reconciled = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!currentAttempt || isTerminalAttempt(currentAttempt)) {
        return { pending: [], failed: [] } as {
          pending: PendingMintOperationRecord<'bolt11'>[];
          failed: FailedMintOperationRecord<'bolt11'>[];
        };
      }
      const pending: PendingMintOperationRecord<'bolt11'>[] = [];
      const failed: FailedMintOperationRecord<'bolt11'>[] = [];
      for (const [index, operation] of operations.entries()) {
        const executing = await this.requireOwnedBolt11Member(tx, attempt.id, operation.id);
        const quote = quotes[index]!;
        const state = getMintQuoteRemoteState(quote);
        if (state === 'PAID' || (state === 'UNPAID' && !isMintQuoteExpired(quote))) {
          const updated: PendingMintOperationRecord<'bolt11'> = {
            ...executing,
            state: 'pending',
            attemptId: undefined,
            outputData: serializeOutputData({ keep: [], send: [] }),
            error: undefined,
            terminalFailure: undefined,
            updatedAt: now,
          };
          await tx.mintOperationRepository.update(updated);
          pending.push(updated);
          continue;
        }
        const error =
          state === 'ISSUED'
            ? `Mint quote ${executing.quoteId} was issued outside the complete exact Mint Batch proof set`
            : `Mint quote ${executing.quoteId} expired before issuance`;
        const updated: FailedMintOperationRecord<'bolt11'> = {
          ...executing,
          state: 'failed',
          attemptId: attempt.id,
          outputData: attempt.outputData,
          error,
          terminalFailure: { reason: error, observedAt: now },
          updatedAt: now,
        };
        await tx.mintOperationRepository.update(updated);
        failed.push(updated);
      }
      const updatedAttempt: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'failed',
        updatedAt: now,
        recoveredAt: now,
        terminalError: {
          message: `Mint Batch ${attempt.id} had independently reconcilable mixed quote states`,
          code: 'MIXED_QUOTE_STATES',
        },
      };
      await tx.mintIssuanceAttemptRepository.update(updatedAttempt);
      return { pending, failed };
    });

    for (const operation of reconciled.pending) {
      this.schedule(operation.id);
      await this.eventBus.emit('mint-op:requeue', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    for (const operation of reconciled.failed) {
      await this.eventBus.emit('mint-op:failed', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    await this.requireOperation(targetOperationId);
  }

  private async failBatchRecovery(
    context: BatchRecoveryContext,
    terminalError: { message: string; code: string },
    recoveredProofs: Proof[],
  ): Promise<void> {
    const { attempt, operations } = context;
    const now = Date.now();
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', recoveredProofs, {
      unit: attempt.unit,
      createdByAttemptId: attempt.id,
    });
    const failed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!currentAttempt) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      const failedOperations: FailedMintOperationRecord<'bolt11'>[] = [];
      if (coreProofs.length > 0) {
        await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
      }
      for (const operation of operations) {
        const executing = await this.requireOwnedBolt11Member(tx, attempt.id, operation.id);
        const updated: FailedMintOperationRecord<'bolt11'> = {
          ...executing,
          state: 'failed',
          attemptId: attempt.id,
          outputData: attempt.outputData,
          error: terminalError.message,
          terminalFailure: { reason: terminalError.message, observedAt: now },
          updatedAt: now,
        };
        await tx.mintOperationRepository.update(updated);
        failedOperations.push(updated);
      }
      await tx.mintIssuanceAttemptRepository.update({
        ...currentAttempt,
        state: 'failed',
        updatedAt: now,
        recoveredAt: now,
        terminalError,
      });
      return failedOperations;
    });

    for (const keysetId of new Set(coreProofs.map((proof) => proof.id))) {
      await this.eventBus.emit('proofs:saved', {
        mintUrl: attempt.mintUrl,
        keysetId,
        proofs: coreProofs.filter((proof) => proof.id === keysetId),
      });
    }
    for (const operation of failed) {
      await this.eventBus.emit('mint-op:failed', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
  }

  private async requireOwnedBolt11Member(
    tx: RepositoryTransactionScope,
    attemptId: string,
    operationId: string,
  ): Promise<ExecutingMintOperationRecord<'bolt11'>> {
    const operation = await tx.mintOperationRepository.getById(operationId);
    if (
      !operation ||
      operation.state !== 'executing' ||
      operation.method !== 'bolt11' ||
      operation.attemptId !== attemptId
    ) {
      throw new Error(`Mint Batch ${attemptId} no longer owns operation ${operationId}`);
    }
    return operation as ExecutingMintOperationRecord<'bolt11'>;
  }

  private handlerDeps() {
    return {
      proofRepository: this.repositories.proofRepository,
      proofService: this.proofService,
      walletService: this.walletService,
      mintService: this.mintService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: this.logger,
    };
  }

  private async executeWithLegacyHandler<M extends MintMethod>(
    operation: ExecutingMintOperationRecord<M>,
  ): Promise<MintExecutionResult> {
    const handler = this.mintHandlerProvider!.get(operation.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return handler.execute({ ...this.handlerDeps(), operation, wallet });
  }

  private async recoverWithLegacyHandler<M extends MintMethod>(
    operation: ExecutingMintOperationRecord<M>,
  ): Promise<RecoverExecutingResult> {
    const handler = this.mintHandlerProvider!.get(operation.method);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return handler.recoverExecuting({ ...this.handlerDeps(), operation, wallet });
  }

  private assertLegacyMethodAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): asserts operation is ExecutingMintOperationRecord {
    if (
      operation.state !== 'executing' ||
      operation.method === 'bolt11' ||
      attempt.method !== operation.method ||
      attempt.memberOperationIds.length !== 1 ||
      attempt.memberOperationIds[0] !== operation.id
    ) {
      throw new Error(`Attempt ${attempt.id} does not have one matching legacy mint operation`);
    }
    if (!this.mintHandlerProvider) {
      throw new Error(`Attempt ${attempt.id} cannot recover without a mint handler provider`);
    }
  }

  private async dispatchLegacyMethodAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    this.assertLegacyMethodAttempt(attempt, operation);
    const submitting = await this.markSubmitting(attempt);
    if (isTerminalAttempt(submitting)) {
      return this.requireTerminalOperation(operation.id, submitting.id);
    }

    try {
      const result = await this.executeWithLegacyHandler(operation);
      switch (result.status) {
        case 'ISSUED':
          this.assertExactProofSet(attempt, result.proofs);
          return this.completeLegacyMethodAttempt(attempt, operation, result.proofs, false);
        case 'ALREADY_ISSUED':
          return this.reconcileLegacyMethodAttempt(submitting, operation);
        case 'FAILED':
          return this.failLegacyMethodAttempt(
            submitting,
            operation,
            result.error ?? 'Mint execution failed',
          );
      }
    } catch (error) {
      const recovering = await this.markRecovering(submitting, error);
      if (isTerminalAttempt(recovering)) {
        return this.requireTerminalOperation(operation.id, recovering.id);
      }
      throw error;
    }
  }

  private async reconcileLegacyMethodAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    this.assertLegacyMethodAttempt(attempt, operation);
    const recovering =
      attempt.state === 'recovering'
        ? attempt
        : await this.markRecovering(attempt, new Error('Legacy recovery join started'));
    if (isTerminalAttempt(recovering)) {
      return this.requireTerminalOperation(operation.id, recovering.id);
    }

    const persisted = await this.getPersistedAttemptProofs(recovering);
    if (persisted) {
      return this.completeLegacyMethodAttempt(recovering, operation, persisted, true);
    }

    const result = await this.recoverWithLegacyHandler(operation);
    switch (result.status) {
      case 'FINALIZED': {
        const proofs = await this.getPersistedAttemptProofs(recovering);
        if (!proofs) {
          throw new Error(`Attempt ${attempt.id} finalized without its exact persisted proofs`);
        }
        return this.completeLegacyMethodAttempt(recovering, operation, proofs, true);
      }
      case 'TERMINAL':
        return this.failLegacyMethodAttempt(recovering, operation, result.error);
      case 'PENDING':
        throw new Error(
          result.error ?? `Legacy mint issuance attempt ${attempt.id} still requires recovery`,
        );
    }
  }

  private async getPersistedAttemptProofs(attempt: MintIssuanceAttempt): Promise<Proof[] | null> {
    const outputs = deserializeOutputData(attempt.outputData);
    const secrets = [...outputs.keep, ...outputs.send].map((output) =>
      new TextDecoder().decode(output.secret),
    );
    const proofs = await this.repositories.proofRepository.getProofsBySecrets(
      attempt.mintUrl,
      secrets,
    );
    return this.matchesExactProofSet(attempt, proofs) ? proofs : null;
  }

  private async completeLegacyMethodAttempt(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord,
    proofs: Proof[],
    proofsAlreadyPersisted: boolean,
  ): Promise<MintOperation> {
    const now = Date.now();
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', proofs, {
      unit: attempt.unit,
      createdByAttemptId: attempt.id,
    });
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation) {
        throw new Error(`Mint issuance attempt ${attempt.id} disappeared during reconciliation`);
      }
      if (currentOperation.state === 'finalized' && currentAttempt.state === 'succeeded') {
        return { operation: currentOperation, committed: false };
      }
      if (currentOperation.state !== 'executing' || currentOperation.attemptId !== attempt.id) {
        throw new Error(`Operation ${operation.id} no longer belongs to attempt ${attempt.id}`);
      }
      if (!proofsAlreadyPersisted) {
        await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
      }
      const finalized: FinalizedMintOperationRecord = {
        ...currentOperation,
        state: 'finalized',
        outputData: attempt.outputData,
        attemptId: attempt.id,
        error: undefined,
        updatedAt: now,
      } as FinalizedMintOperationRecord;
      const succeeded: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'succeeded',
        updatedAt: now,
        recoveredAt: proofsAlreadyPersisted ? now : currentAttempt.recoveredAt,
        terminalError: undefined,
      };
      await tx.mintOperationRepository.update(finalized);
      await tx.mintIssuanceAttemptRepository.update(succeeded);
      return { operation: finalized, committed: true };
    });

    if (!completed.committed) return toMintOperation(completed.operation);
    if (!proofsAlreadyPersisted) {
      for (const keysetId of new Set(coreProofs.map((proof) => proof.id))) {
        await this.eventBus.emit('proofs:saved', {
          mintUrl: attempt.mintUrl,
          keysetId,
          proofs: coreProofs.filter((proof) => proof.id === keysetId),
        });
      }
    }
    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: completed.operation.mintUrl,
      operationId: completed.operation.id,
      operation: toMintOperation(completed.operation),
    });
    return toMintOperation(completed.operation);
  }

  private async failLegacyMethodAttempt(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord,
    error: string,
  ): Promise<MintOperation> {
    const now = Date.now();
    const failed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation || currentOperation.state !== 'executing') {
        throw new Error(`Cannot fail inconsistent mint issuance attempt ${attempt.id}`);
      }
      const failedOperation: FailedMintOperationRecord = {
        ...currentOperation,
        state: 'failed',
        attemptId: attempt.id,
        outputData: attempt.outputData,
        error,
        terminalFailure: { reason: error, observedAt: now },
        updatedAt: now,
      } as FailedMintOperationRecord;
      const failedAttempt: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'failed',
        updatedAt: now,
        terminalError: { message: error },
      };
      await tx.mintOperationRepository.update(failedOperation);
      await tx.mintIssuanceAttemptRepository.update(failedAttempt);
      return failedOperation;
    });
    await this.eventBus.emit('mint-op:failed', {
      mintUrl: failed.mintUrl,
      operationId: failed.id,
      operation: toMintOperation(failed),
    });
    return toMintOperation(failed);
  }

  private assertExactProofSet(attempt: MintIssuanceAttempt, proofs: Proof[]): void {
    if (!this.matchesExactProofSet(attempt, proofs)) {
      throw new Error(`Mint issuance attempt ${attempt.id} did not return its exact proof set`);
    }
  }

  private matchesExactProofSet(attempt: MintIssuanceAttempt, proofs: Proof[]): boolean {
    const outputData = deserializeOutputData(attempt.outputData);
    const expected = [...outputData.keep, ...outputData.send]
      .map((output) => ({
        secret: new TextDecoder().decode(output.secret),
        id: output.blindedMessage.id,
        amount: output.blindedMessage.amount,
      }))
      .sort((left, right) => left.secret.localeCompare(right.secret));
    const received = [...proofs].sort((left, right) => left.secret.localeCompare(right.secret));
    return !(
      expected.length === 0 ||
      expected.length !== received.length ||
      new Set(received.map((proof) => proof.secret)).size !== received.length ||
      expected.some((output, index) => {
        const proof = received[index];
        return (
          !proof ||
          output.secret !== proof.secret ||
          output.id !== proof.id ||
          !output.amount.equals(proof.amount)
        );
      })
    );
  }

  private async completeAttempt(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord<'bolt11'>,
    proofs: Proof[],
    recovered: boolean,
  ): Promise<MintOperation> {
    const now = Date.now();
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', proofs, {
      unit: attempt.unit,
      createdByAttemptId: attempt.id,
    });
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation) {
        throw new Error(`Mint issuance attempt ${attempt.id} disappeared during reconciliation`);
      }
      if (currentOperation.state === 'finalized' && currentAttempt.state === 'succeeded') {
        return {
          operation: currentOperation as FinalizedMintOperationRecord<'bolt11'>,
          quote: await tx.mintQuoteRepository.getMintQuote(
            attempt.mintUrl,
            'bolt11',
            operation.quoteId,
          ),
          quoteChanged: false,
          committed: false,
        };
      }
      if (currentOperation.state !== 'executing' || currentOperation.attemptId !== attempt.id) {
        throw new Error(`Operation ${operation.id} no longer belongs to attempt ${attempt.id}`);
      }

      const quoteBefore = await tx.mintQuoteRepository.getMintQuote(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
      );
      if (!quoteBefore) {
        throw new Error(`Mint quote ${operation.quoteId} disappeared during reconciliation`);
      }
      await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
      await tx.mintQuoteRepository.setMintQuoteState(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
        'ISSUED',
        now,
      );
      const finalized: FinalizedMintOperationRecord<'bolt11'> = {
        ...currentOperation,
        method: 'bolt11',
        state: 'finalized',
        outputData: attempt.outputData,
        attemptId: attempt.id,
        error: undefined,
        updatedAt: now,
      };
      const succeeded: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'succeeded',
        updatedAt: now,
        recoveredAt: recovered ? now : currentAttempt.recoveredAt,
        terminalError: undefined,
      };
      await tx.mintOperationRepository.update(finalized);
      await tx.mintIssuanceAttemptRepository.update(succeeded);
      return {
        operation: finalized,
        quote: await tx.mintQuoteRepository.getMintQuote(
          attempt.mintUrl,
          'bolt11',
          operation.quoteId,
        ),
        quoteChanged: getMintQuoteRemoteState(quoteBefore) !== 'ISSUED',
        committed: true,
      };
    });

    if (!completed.committed) {
      return toMintOperation(completed.operation);
    }
    for (const keysetId of new Set(coreProofs.map((proof) => proof.id))) {
      await this.eventBus.emit('proofs:saved', {
        mintUrl: attempt.mintUrl,
        keysetId,
        proofs: coreProofs.filter((proof) => proof.id === keysetId),
      });
    }
    if (completed.quote && completed.quoteChanged) {
      await this.eventBus.emit('mint-quote:updated', {
        mintUrl: completed.quote.mintUrl,
        method: completed.quote.method,
        quoteId: completed.quote.quoteId,
        quote: completed.quote,
      });
    }
    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: completed.operation.mintUrl,
      operationId: completed.operation.id,
      operation: toMintOperation(completed.operation),
    });
    this.logger?.info('Mint issuance attempt succeeded', {
      attemptId: attempt.id,
      memberOperationIds: attempt.memberOperationIds,
      mintUrl: attempt.mintUrl,
      method: attempt.method,
      unit: attempt.unit,
    });
    return toMintOperation(completed.operation);
  }

  private async completeBatchAttempt(
    attempt: MintIssuanceAttempt,
    operations: ExecutingMintOperationRecord<'bolt11'>[],
    proofs: Proof[],
    recovered: boolean,
    targetOperationId: string,
  ): Promise<MintOperation> {
    const now = Date.now();
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', proofs, {
      unit: attempt.unit,
      createdByAttemptId: attempt.id,
    });
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!currentAttempt) {
        throw new Error(`Mint issuance attempt ${attempt.id} disappeared during reconciliation`);
      }
      const currentOperations = await Promise.all(
        attempt.memberOperationIds.map((operationId) =>
          tx.mintOperationRepository.getById(operationId),
        ),
      );
      if (
        currentAttempt.state === 'succeeded' &&
        currentOperations.every((operation) => operation?.state === 'finalized')
      ) {
        return {
          operations: currentOperations as FinalizedMintOperationRecord<'bolt11'>[],
          quotes: [] as MintQuote<'bolt11'>[],
          committed: false,
        };
      }
      if (
        currentOperations.some(
          (operation) =>
            !operation ||
            operation.state !== 'executing' ||
            operation.method !== 'bolt11' ||
            operation.attemptId !== attempt.id,
        )
      ) {
        throw new Error(`Mint Batch ${attempt.id} no longer owns all of its members`);
      }

      const quoteEvents: MintQuote<'bolt11'>[] = [];
      await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
      const finalized: FinalizedMintOperationRecord<'bolt11'>[] = [];
      for (const [index, operation] of currentOperations.entries()) {
        const currentOperation = operation as ExecutingMintOperationRecord<'bolt11'>;
        const quoteId = attempt.quoteIds[index]!;
        const quoteBefore = await tx.mintQuoteRepository.getMintQuote(
          attempt.mintUrl,
          'bolt11',
          quoteId,
        );
        if (!quoteBefore || quoteBefore.method !== 'bolt11') {
          throw new Error(`Mint quote ${quoteId} disappeared during reconciliation`);
        }
        await tx.mintQuoteRepository.setMintQuoteState(
          attempt.mintUrl,
          'bolt11',
          quoteId,
          'ISSUED',
          now,
        );
        const finalizedOperation: FinalizedMintOperationRecord<'bolt11'> = {
          ...currentOperation,
          state: 'finalized',
          outputData: attempt.outputData,
          attemptId: attempt.id,
          error: undefined,
          updatedAt: now,
        };
        await tx.mintOperationRepository.update(finalizedOperation);
        finalized.push(finalizedOperation);
        if (getMintQuoteRemoteState(quoteBefore) !== 'ISSUED') {
          const updatedQuote = await tx.mintQuoteRepository.getMintQuote(
            attempt.mintUrl,
            'bolt11',
            quoteId,
          );
          if (updatedQuote?.method === 'bolt11') quoteEvents.push(updatedQuote);
        }
      }
      const succeeded: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'succeeded',
        updatedAt: now,
        recoveredAt: recovered ? now : currentAttempt.recoveredAt,
        terminalError: undefined,
      };
      await tx.mintIssuanceAttemptRepository.update(succeeded);
      return { operations: finalized, quotes: quoteEvents, committed: true };
    });

    const target = completed.operations.find((operation) => operation.id === targetOperationId);
    if (!target) throw new Error(`Mint Batch ${attempt.id} does not contain ${targetOperationId}`);
    if (!completed.committed) return toMintOperation(target);

    for (const keysetId of new Set(coreProofs.map((proof) => proof.id))) {
      await this.eventBus.emit('proofs:saved', {
        mintUrl: attempt.mintUrl,
        keysetId,
        proofs: coreProofs.filter((proof) => proof.id === keysetId),
      });
    }
    for (const quote of completed.quotes) {
      await this.eventBus.emit('mint-quote:updated', {
        mintUrl: quote.mintUrl,
        method: quote.method,
        quoteId: quote.quoteId,
        quote,
      });
    }
    for (const operation of completed.operations) {
      await this.eventBus.emit('mint-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: toMintOperation(operation),
      });
    }
    this.logger?.info('Mint issuance attempt succeeded', {
      attemptId: attempt.id,
      memberOperationIds: attempt.memberOperationIds,
      mintUrl: attempt.mintUrl,
      method: attempt.method,
      unit: attempt.unit,
    });
    return toMintOperation(target);
  }

  private async failAttemptAsExternallyRedeemed(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord<'bolt11'>,
  ): Promise<MintOperation> {
    const now = Date.now();
    const error = `Mint quote ${operation.quoteId} was issued but its exact proofs could not be recovered`;
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation || currentOperation.state !== 'executing') {
        throw new Error(`Cannot fail inconsistent mint issuance attempt ${attempt.id}`);
      }
      const quoteBefore = await tx.mintQuoteRepository.getMintQuote(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
      );
      if (!quoteBefore) {
        throw new Error(`Mint quote ${operation.quoteId} disappeared during reconciliation`);
      }
      await tx.mintQuoteRepository.setMintQuoteState(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
        'ISSUED',
        now,
      );
      const failedOperation: FailedMintOperationRecord<'bolt11'> = {
        ...currentOperation,
        method: 'bolt11',
        state: 'failed',
        attemptId: attempt.id,
        outputData: attempt.outputData,
        error,
        terminalFailure: { reason: error, observedAt: now },
        updatedAt: now,
      };
      const failedAttempt: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'failed',
        updatedAt: now,
        terminalError: { message: error, code: 'EXACT_PROOFS_UNRECOVERABLE' },
      };
      await tx.mintOperationRepository.update(failedOperation);
      await tx.mintIssuanceAttemptRepository.update(failedAttempt);
      return {
        operation: failedOperation,
        quote: await tx.mintQuoteRepository.getMintQuote(
          attempt.mintUrl,
          'bolt11',
          operation.quoteId,
        ),
        quoteChanged: getMintQuoteRemoteState(quoteBefore) !== 'ISSUED',
      };
    });

    if (completed.quote && completed.quoteChanged) {
      await this.eventBus.emit('mint-quote:updated', {
        mintUrl: completed.quote.mintUrl,
        method: completed.quote.method,
        quoteId: completed.quote.quoteId,
        quote: completed.quote,
      });
    }
    await this.eventBus.emit('mint-op:failed', {
      mintUrl: completed.operation.mintUrl,
      operationId: completed.operation.id,
      operation: toMintOperation(completed.operation),
    });
    return toMintOperation(completed.operation);
  }

  private async markRecovering(
    attempt: MintIssuanceAttempt,
    error: unknown,
  ): Promise<MintIssuanceAttempt> {
    const recovering = await this.repositories.withTransaction(async (tx) => {
      const current = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!current) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      if (isTerminalAttempt(current)) return current;

      const now = Date.now();
      const updated: MintIssuanceAttempt = {
        ...current,
        state: 'recovering',
        recoveryStartedAt: current.recoveryStartedAt ?? now,
        updatedAt: now,
        terminalError: undefined,
      };
      await tx.mintIssuanceAttemptRepository.update(updated);
      return updated;
    });
    this.logger?.warn('Mint issuance attempt requires recovery', {
      attemptId: attempt.id,
      memberOperationIds: attempt.memberOperationIds,
      mintUrl: attempt.mintUrl,
      method: attempt.method,
      unit: attempt.unit,
      error: error instanceof Error ? error.message : String(error),
    });
    return recovering;
  }

  private async requireTerminalOperation(
    operationId: string,
    attemptId: string,
  ): Promise<MintOperation> {
    const operation = await this.requireOperation(operationId);
    if (!isTerminalOperation(operation)) {
      throw new Error(`Terminal attempt ${attemptId} has non-terminal operation ${operationId}`);
    }
    return toMintOperation(operation);
  }

  private async requireOperation(operationId: string): Promise<MintOperationRecord> {
    const operation = await this.repositories.mintOperationRepository.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    return operation;
  }
}
