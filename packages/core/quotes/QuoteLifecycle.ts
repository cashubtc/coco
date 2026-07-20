import {
  Amount,
  type AmountLike,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
} from '@cashu/cashu-ts';
import type { UnitAmount } from '../amounts.ts';
import { DEFAULT_UNIT, normalizeUnit, normalizeUnitAmount } from '../amounts.ts';
import type { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { MintAdapter } from '../infra';
import type { MeltHandlerProvider } from '../infra/handlers/melt';
import type { MintHandlerProvider } from '../infra/handlers/mint';
import type { Logger } from '../logging/Logger';
import {
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
  mintQuoteToMethodSnapshot,
  isStatefulMintQuote,
  type MintQuote,
} from '../models/MintQuote';
import { meltQuoteToMethodSnapshot, type MeltQuote } from '../models/MeltQuote';
import { isMintQuoteExpired } from '../models/MintQuoteExpiry';
import {
  HttpResponseError,
  MintOperationError,
  NetworkError,
  ProofValidationError,
  QuoteIdentityConflictError,
  UnknownMintError,
} from '../models/Error';
import type { MeltQuoteRepository, MintQuoteRepository, ProofRepository } from '../repositories';
import type { MintService } from '../services/MintService';
import type { ProofService } from '../services/ProofService';
import type { WalletService } from '../services/WalletService';
import type { InitMeltOperation } from '../operations/melt/MeltOperation';
import { normalizeMintUrl } from '../utils';
import type {
  MeltMethod,
  MeltMethodInputData,
  MeltMethodQuoteSnapshot,
} from '../operations/melt/MeltMethodHandler';
import { normalizeMeltMethodData } from '../operations/melt/MeltMethodHandler';
import type { InitMintOperation, PendingOrLaterOperation } from '../operations/mint/MintOperation';
import type {
  MintMethod,
  MintMethodCreateQuoteData,
  MintMethodQuoteSnapshot,
  MintMethodRemoteState,
} from '../operations/mint/MintMethodHandler';
import type { MeltQuoteRef, MintQuoteRef, QuoteIdentity } from '../models/QuoteIdentity';
import type {
  MintQuotePollingFailure,
  MintQuotePollingOutcome,
  MintQuotePollingResult,
} from './MintQuotePolling.ts';

const MINT_QUOTE_STATE_RANK: Record<string, number> = {
  UNPAID: 0,
  PAID: 1,
  ISSUED: 2,
};

const BUILT_IN_MINT_METHODS = new Set<MintMethod>(['bolt11', 'bolt12', 'onchain']);
const DEFINITIVE_BATCH_FAILURE_CATEGORIES = new Set<MintQuotePollingFailure['category']>([
  'incompatibility',
  'batch-size',
  'malformed-response',
  'validation',
]);

function isMintQuoteStateDowngrade(
  existing: MintMethodRemoteState,
  incoming: MintMethodRemoteState,
): boolean {
  return (MINT_QUOTE_STATE_RANK[incoming] ?? 0) < (MINT_QUOTE_STATE_RANK[existing] ?? 0);
}

function maxAmount(left: Amount, right: Amount): Amount {
  return left.greaterThan(right) ? left : right;
}

function hasReusableSettlementAmounts(snapshot: {
  amount_paid?: unknown;
  amount_issued?: unknown;
}): boolean {
  return snapshot.amount_paid !== undefined && snapshot.amount_issued !== undefined;
}

function normalizeBolt11MintQuotePollingState(
  snapshot: MintMethodQuoteSnapshot<'bolt11'>,
): MintMethodRemoteState<'bolt11'> {
  const accounting = snapshot as MintMethodQuoteSnapshot<'bolt11'> & {
    amount_paid?: unknown;
    amount_issued?: unknown;
  };
  const hasAmountPaid = accounting.amount_paid !== undefined;
  const hasAmountIssued = accounting.amount_issued !== undefined;
  if (hasAmountPaid !== hasAmountIssued) {
    throw new ProofValidationError(
      'BOLT11 mint quote batch observation has incomplete accounting fields',
    );
  }
  if (hasAmountPaid) {
    const amountPaid = Amount.from(accounting.amount_paid as AmountLike);
    const amountIssued = Amount.from(accounting.amount_issued as AmountLike);
    if (amountPaid.lessThan(amountIssued)) {
      throw new ProofValidationError(
        'BOLT11 mint quote batch observation has amount_issued greater than amount_paid',
      );
    }
    if (amountPaid.isZero()) return 'UNPAID';
    return amountPaid.greaterThan(amountIssued) ? 'PAID' : 'ISSUED';
  }
  return snapshot.state;
}

function assertMintQuotePollingSnapshotStructureUnchecked(
  method: MintMethod,
  snapshot: MintMethodQuoteSnapshot,
): MintMethodQuoteSnapshot {
  if (
    typeof snapshot.quote !== 'string' ||
    snapshot.quote.length === 0 ||
    typeof snapshot.request !== 'string' ||
    snapshot.request.length === 0 ||
    typeof snapshot.unit !== 'string' ||
    snapshot.unit.trim().length === 0 ||
    (snapshot.expiry !== null &&
      snapshot.expiry !== undefined &&
      !Number.isSafeInteger(snapshot.expiry)) ||
    (snapshot.pubkey !== undefined && typeof snapshot.pubkey !== 'string')
  ) {
    throw new ProofValidationError('Mint quote batch observation has invalid base fields');
  }

  if (method === 'bolt11') {
    const bolt11 = snapshot as MintMethodQuoteSnapshot<'bolt11'>;
    const amount = Amount.from(bolt11.amount as AmountLike);
    const state = normalizeBolt11MintQuotePollingState(bolt11);
    if (amount.isZero() || (state !== 'UNPAID' && state !== 'PAID' && state !== 'ISSUED')) {
      throw new ProofValidationError('BOLT11 mint quote batch observation is invalid');
    }
    return { ...bolt11, state };
  }

  const reusable = snapshot as
    | MintMethodQuoteSnapshot<'bolt12'>
    | MintMethodQuoteSnapshot<'onchain'>;
  if (!hasReusableSettlementAmounts(reusable)) {
    throw new ProofValidationError(`${method} mint quote batch observation lacks settlement data`);
  }
  const amountPaid = Amount.from(reusable.amount_paid);
  const amountIssued = Amount.from(reusable.amount_issued);
  if (amountPaid.lessThan(amountIssued)) {
    throw new ProofValidationError(
      `${method} mint quote batch observation has amount_issued greater than amount_paid`,
    );
  }
  if (method === 'bolt12') {
    const amount = (snapshot as MintMethodQuoteSnapshot<'bolt12'>).amount;
    if (amount !== undefined && amount !== null) Amount.from(amount as AmountLike);
  }
  return snapshot;
}

function assertMintQuotePollingSnapshotStructure(
  method: MintMethod,
  snapshot: MintMethodQuoteSnapshot,
): MintMethodQuoteSnapshot {
  try {
    return assertMintQuotePollingSnapshotStructureUnchecked(method, snapshot);
  } catch (error) {
    if (error instanceof ProofValidationError) throw error;
    const validationError = new ProofValidationError(
      `${method} mint quote batch observation has invalid amount fields`,
    );
    (validationError as Error & { cause?: unknown }).cause = error;
    throw validationError;
  }
}

function isDefinitiveMintQuotePollingValidation(error: Error): boolean {
  return error instanceof ProofValidationError || error instanceof QuoteIdentityConflictError;
}

function equalOptionalAmount(
  left: AmountLike | null | undefined,
  right: AmountLike | null | undefined,
) {
  if (left == null || right == null) return left == null && right == null;
  return Amount.from(left).equals(Amount.from(right));
}

function areMintQuotePollingSnapshotsEqual(
  method: MintMethod,
  left: MintMethodQuoteSnapshot,
  right: MintMethodQuoteSnapshot,
): boolean {
  if (
    left.quote !== right.quote ||
    left.request !== right.request ||
    normalizeUnit(left.unit) !== normalizeUnit(right.unit) ||
    left.expiry !== right.expiry ||
    left.pubkey !== right.pubkey
  ) {
    return false;
  }
  if (method === 'bolt11') {
    const leftBolt11 = left as MintMethodQuoteSnapshot<'bolt11'>;
    const rightBolt11 = right as MintMethodQuoteSnapshot<'bolt11'>;
    return (
      Amount.from(leftBolt11.amount).equals(Amount.from(rightBolt11.amount)) &&
      leftBolt11.state === rightBolt11.state
    );
  }

  const leftReusable = left as
    | MintMethodQuoteSnapshot<'bolt12'>
    | MintMethodQuoteSnapshot<'onchain'>;
  const rightReusable = right as
    | MintMethodQuoteSnapshot<'bolt12'>
    | MintMethodQuoteSnapshot<'onchain'>;
  if (
    !Amount.from(leftReusable.amount_paid).equals(Amount.from(rightReusable.amount_paid)) ||
    !Amount.from(leftReusable.amount_issued).equals(Amount.from(rightReusable.amount_issued))
  ) {
    return false;
  }
  return (
    method !== 'bolt12' ||
    equalOptionalAmount(
      (left as MintMethodQuoteSnapshot<'bolt12'>).amount,
      (right as MintMethodQuoteSnapshot<'bolt12'>).amount,
    )
  );
}

function normalizePollingError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function classifyMintQuotePollingFailure(error: unknown): MintQuotePollingFailure['category'] {
  if (error instanceof NetworkError) return 'network';
  if (error instanceof MintOperationError) {
    if (error.code === 11_017) return 'batch-size';
    if (error.code === 31_004) return 'rate-limit';
    if (error.code >= 30_000) return 'authentication';
    return 'validation';
  }
  if (error instanceof HttpResponseError) {
    if (error.status >= 200 && error.status < 300) return 'malformed-response';
    if (error.status === 401 || error.status === 403) return 'authentication';
    if (error.status === 429) return 'rate-limit';
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return 'incompatibility';
    }
    if (error.status >= 500) return 'server';
  }
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== error) return classifyMintQuotePollingFailure(cause);
  }
  if (error instanceof Error && /auth/i.test(error.name)) return 'authentication';
  return 'validation';
}

function failedMintQuotePollingResult(
  identities: readonly QuoteIdentity[],
  category: MintQuotePollingFailure['category'],
  error: unknown,
): MintQuotePollingResult {
  const normalizedError = normalizePollingError(error);
  return {
    outcomes: identities.map((identity) => ({
      status: 'failed',
      identity,
      failure: { category, error: normalizedError },
    })),
    responseFailures: [],
  };
}

function getRemoteStateChange(
  existing: MintQuote | null,
  incoming: MintQuote,
  rawSnapshot?: MintMethodQuoteSnapshot,
): boolean {
  if (!existing) {
    return true;
  }

  if (existing.method !== incoming.method || existing.quoteId !== incoming.quoteId) {
    return true;
  }

  if (existing.method === 'bolt11' && incoming.method === 'bolt11') {
    return existing.state !== incoming.state;
  }

  if (existing.reusable && incoming.reusable) {
    const snapshot = rawSnapshot as
      | (MintMethodQuoteSnapshot<'onchain'> | MintMethodQuoteSnapshot<'bolt12'>)
      | undefined;
    if (!snapshot || hasReusableSettlementAmounts(snapshot)) {
      return (
        !existing.quoteData.amountPaid.equals(incoming.quoteData.amountPaid) ||
        !existing.quoteData.amountIssued.equals(incoming.quoteData.amountIssued)
      );
    }

    const existingState = (existing as { state?: unknown }).state;
    const incomingState = (rawSnapshot as { state?: unknown }).state;
    return incomingState !== undefined && existingState !== incomingState;
  }

  return false;
}

function serializeMeltChange(change: MeltQuote['change']): NonNullable<MeltQuote['change']> {
  return change ?? [];
}

function getMeaningfulMeltQuoteFields(quote: MeltQuote): unknown {
  const base = {
    method: quote.method,
    quoteId: quote.quoteId,
    request: quote.request,
    amount: quote.amount.toString(),
    unit: quote.unit,
    expiry: quote.expiry,
    state: quote.state,
    change: serializeMeltChange(quote.change),
  };

  if (quote.method === 'onchain') {
    return {
      ...base,
      fee_options: quote.fee_options.map((option) => ({
        fee_index: option.fee_index,
        fee_reserve: option.fee_reserve.toString(),
        estimated_blocks: option.estimated_blocks,
      })),
      outpoint: quote.outpoint ?? null,
    };
  }

  return {
    ...base,
    fee_reserve: quote.fee_reserve.toString(),
    payment_preimage: quote.payment_preimage ?? null,
  };
}

function getMeltQuoteChange(existing: MeltQuote | null, incoming: MeltQuote): boolean {
  if (!existing) {
    return true;
  }

  return (
    JSON.stringify(getMeaningfulMeltQuoteFields(existing)) !==
    JSON.stringify(getMeaningfulMeltQuoteFields(incoming))
  );
}

function mergePaidMeltQuoteSettlement(existing: MeltQuote, incoming: MeltQuote): MeltQuote | null {
  if (
    existing.state !== 'PAID' ||
    incoming.state !== 'PAID' ||
    existing.method !== incoming.method
  ) {
    return null;
  }

  let changed = false;
  let merged = {
    ...existing,
    lastObservedRemoteState: incoming.lastObservedRemoteState ?? existing.lastObservedRemoteState,
    lastObservedRemoteStateAt:
      incoming.lastObservedRemoteStateAt ?? existing.lastObservedRemoteStateAt,
    updatedAt: incoming.updatedAt,
  } as MeltQuote;

  if (!Array.isArray(existing.change) && Array.isArray(incoming.change)) {
    merged = { ...merged, change: incoming.change } as MeltQuote;
    changed = true;
  }

  if (existing.method === 'onchain' && incoming.method === 'onchain') {
    if (existing.outpoint == null && incoming.outpoint != null) {
      merged = { ...merged, outpoint: incoming.outpoint } as MeltQuote;
      changed = true;
    }
  } else if (existing.method !== 'onchain' && incoming.method !== 'onchain') {
    if (existing.payment_preimage == null && incoming.payment_preimage != null) {
      merged = { ...merged, payment_preimage: incoming.payment_preimage } as MeltQuote;
      changed = true;
    }
  }

  return changed ? merged : null;
}

export interface QuoteLifecycleDeps {
  mintHandlerProvider: MintHandlerProvider;
  meltHandlerProvider: MeltHandlerProvider;
  mintQuoteRepository: MintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
  proofRepository: ProofRepository;
  proofService: ProofService;
  mintService: MintService;
  walletService: WalletService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
}

export class QuoteLifecycle {
  private readonly mintHandlerProvider: MintHandlerProvider;
  private readonly meltHandlerProvider: MeltHandlerProvider;
  private readonly mintQuoteRepository: MintQuoteRepository;
  private readonly meltQuoteRepository: MeltQuoteRepository;
  private readonly proofRepository: ProofRepository;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly batchUnavailablePollingMethodsByMint = new Map<string, Set<MintMethod>>();

  constructor(deps: QuoteLifecycleDeps) {
    this.mintHandlerProvider = deps.mintHandlerProvider;
    this.meltHandlerProvider = deps.meltHandlerProvider;
    this.mintQuoteRepository = deps.mintQuoteRepository;
    this.meltQuoteRepository = deps.meltQuoteRepository;
    this.proofRepository = deps.proofRepository;
    this.proofService = deps.proofService;
    this.mintService = deps.mintService;
    this.walletService = deps.walletService;
    this.mintAdapter = deps.mintAdapter;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger;
    this.eventBus.on('mint:metadata-refreshed', ({ mintUrl }) => {
      this.clearBatchUnavailablePollingGroups(mintUrl);
    });
  }

  private isBatchUnavailableForPolling(mintUrl: string, method: MintMethod): boolean {
    return (
      this.batchUnavailablePollingMethodsByMint.get(normalizeMintUrl(mintUrl))?.has(method) === true
    );
  }

  private markBatchUnavailableForPolling(mintUrl: string, method: MintMethod): void {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const unavailableMethods =
      this.batchUnavailablePollingMethodsByMint.get(normalizedMintUrl) ?? new Set<MintMethod>();
    if (unavailableMethods.has(method)) return;
    unavailableMethods.add(method);
    this.batchUnavailablePollingMethodsByMint.set(normalizedMintUrl, unavailableMethods);
    this.logger?.warn('Disabling batch mint quote polling for the Coco Session', {
      mintUrl: normalizedMintUrl,
      method,
    });
  }

  private clearBatchUnavailablePollingGroups(mintUrl: string): void {
    this.batchUnavailablePollingMethodsByMint.delete(normalizeMintUrl(mintUrl));
  }

  private recordDefinitiveBatchPollingFailure(
    mintUrl: string,
    method: MintMethod,
    category: MintQuotePollingFailure['category'],
  ): void {
    if (DEFINITIVE_BATCH_FAILURE_CATEGORIES.has(category)) {
      this.markBatchUnavailableForPolling(mintUrl, method);
    }
  }

  private buildDeps() {
    return {
      proofRepository: this.proofRepository,
      proofService: this.proofService,
      walletService: this.walletService,
      mintService: this.mintService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: this.logger,
    };
  }

  private async refreshResolvedMintQuote(existingQuote: MintQuote): Promise<MintQuote> {
    const handler = this.mintHandlerProvider.get(existingQuote.method);
    const refreshed = await handler.fetchRemoteQuote({
      ...this.buildDeps(),
      quote: existingQuote,
    });

    const remoteStateChanged = getRemoteStateChange(existingQuote, refreshed);
    const quote = await this.persistCanonicalMintQuote(refreshed);
    await this.emitMintQuoteUpdatedIfNeeded(quote, remoteStateChanged);
    return quote;
  }

  private async refreshResolvedMeltQuote(existingQuote: MeltQuote): Promise<MeltQuote> {
    const handler = this.meltHandlerProvider.get(existingQuote.method);
    const refreshed = await handler.fetchRemoteQuote({
      ...this.buildDeps(),
      quote: existingQuote,
    });

    const quote = await this.recordMeltQuoteObservation(refreshed);
    return quote;
  }

  async createMintQuote(mintUrl: string, intent: UnitAmount, method?: 'bolt11'): Promise<MintQuote>;
  async createMintQuote<M extends MintMethod>(
    mintUrl: string,
    method: M,
    createQuoteData: MintMethodCreateQuoteData<M>,
  ): Promise<MintQuote<M>>;
  async createMintQuote(
    mintUrl: string,
    methodOrIntent: MintMethod | UnitAmount,
    createQuoteDataOrMethod?: MintMethodCreateQuoteData | 'bolt11',
  ): Promise<MintQuote> {
    const method =
      typeof methodOrIntent === 'string'
        ? methodOrIntent
        : typeof createQuoteDataOrMethod === 'string'
          ? createQuoteDataOrMethod
          : 'bolt11';
    const createQuoteData =
      typeof methodOrIntent === 'string'
        ? (createQuoteDataOrMethod as MintMethodCreateQuoteData)
        : ({ amount: normalizeUnitAmount(methodOrIntent) } as MintMethodCreateQuoteData);
    const parsed =
      'amount' in createQuoteData && createQuoteData.amount !== undefined
        ? normalizeUnitAmount(createQuoteData.amount)
        : undefined;
    const unit =
      parsed?.unit ??
      normalizeUnit('unit' in createQuoteData ? createQuoteData.unit : undefined, {
        defaultUnit: DEFAULT_UNIT,
      });
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    if (parsed?.amount.isZero()) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    await this.mintService.assertMethodUnitSupported(mintUrl, 4, method, parsed ?? unit);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);

    const handler = this.mintHandlerProvider.get(method);
    const quote = await handler.createQuote({
      ...this.buildDeps(),
      mintUrl,
      createQuoteData,
      wallet,
    } as any);

    await this.mintQuoteRepository.upsertMintQuote(quote);
    const persistedQuote =
      (await this.mintQuoteRepository.getMintQuote(mintUrl, method, quote.quoteId)) ?? quote;
    this.logger?.info('Mint quote created', {
      mintUrl: persistedQuote.mintUrl,
      quoteId: persistedQuote.quoteId,
      method,
      amount: getMintQuoteAmount(persistedQuote)?.toString(),
      unit: persistedQuote.unit,
    });
    await this.eventBus.emit('mint-quote:updated', {
      mintUrl: persistedQuote.mintUrl,
      method: persistedQuote.method,
      quoteId: persistedQuote.quoteId,
      quote: persistedQuote,
    });
    return persistedQuote;
  }

  getMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote | null> {
    return this.mintQuoteRepository.getMintQuote(mintUrl, method, quoteId);
  }

  getMintQuoteById(identity: QuoteIdentity): Promise<MintQuote | null> {
    return this.mintQuoteRepository.getMintQuoteById(identity);
  }

  getPendingMintQuotes(method?: MintMethod): Promise<MintQuote[]> {
    return this.mintQuoteRepository.getPendingMintQuotes(method);
  }

  /** Returns the advertised and safety-capped size for one Background Watcher opportunity. */
  async getMintQuotePollingLimit(mintUrl: string, method: MintMethod): Promise<number> {
    if (this.isBatchUnavailableForPolling(mintUrl, method)) return 1;
    return this.mintService.getNut29MintQuoteCheckLimit(mintUrl, method);
  }

  /**
   * Checks selected mint quotes through the lifecycle polling seam.
   *
   * NUT-29 is used when advertised, with identity-based response attribution and
   * one explicit outcome for every selected quote. Attributable observations are
   * persisted before any update events are emitted, even when other response
   * elements are missing, duplicated, extra, malformed, or conflict with canonical
   * quote data. A single selection falls back to the existing single-quote endpoint
   * when NUT-29 is unavailable; multiple selections never fan out implicitly.
   */
  async checkMintQuotesForPolling(
    method: MintMethod,
    identities: readonly QuoteIdentity[],
  ): Promise<MintQuotePollingResult> {
    if (identities.length === 0) {
      return { outcomes: [], responseFailures: [] };
    }

    const normalizedIdentities = identities.map((identity) => ({
      mintUrl: normalizeMintUrl(identity.mintUrl),
      quoteId: identity.quoteId,
    }));
    const mintUrl = normalizedIdentities[0]!.mintUrl;
    const uniqueMintUrls = new Set(normalizedIdentities.map((identity) => identity.mintUrl));
    const uniqueQuoteIds = new Set(normalizedIdentities.map((identity) => identity.quoteId));
    if (
      uniqueMintUrls.size !== 1 ||
      uniqueQuoteIds.size !== normalizedIdentities.length ||
      normalizedIdentities.some((identity) => identity.quoteId.length === 0)
    ) {
      return failedMintQuotePollingResult(
        normalizedIdentities,
        'validation',
        new ProofValidationError(
          'Mint quote polling selections require one mint and unique non-empty quote identities',
        ),
      );
    }
    if (!BUILT_IN_MINT_METHODS.has(method)) {
      return failedMintQuotePollingResult(
        normalizedIdentities,
        'validation',
        new ProofValidationError(`Unsupported built-in mint quote polling method ${method}`),
      );
    }
    if (!(await this.mintService.isTrustedMint(mintUrl))) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    let useBatch: boolean;
    try {
      useBatch =
        !this.isBatchUnavailableForPolling(mintUrl, method) &&
        (await this.mintService.supportsNut29MintQuoteCheck(mintUrl, method));
    } catch (error) {
      return failedMintQuotePollingResult(
        normalizedIdentities,
        classifyMintQuotePollingFailure(error),
        error,
      );
    }
    if (!useBatch && normalizedIdentities.length > 1) {
      return failedMintQuotePollingResult(
        normalizedIdentities,
        'incompatibility',
        new ProofValidationError(
          `Mint ${mintUrl} does not advertise NUT-29 quote checks for ${method}`,
        ),
      );
    }

    let response: unknown;
    try {
      response = useBatch
        ? await this.mintAdapter.checkMintQuoteBatch(
            mintUrl,
            method,
            normalizedIdentities.map((identity) => identity.quoteId),
          )
        : [
            await this.mintAdapter.checkMintQuote(
              mintUrl,
              method,
              normalizedIdentities[0]!.quoteId,
            ),
          ];
    } catch (error) {
      const category = classifyMintQuotePollingFailure(error);
      if (useBatch) this.recordDefinitiveBatchPollingFailure(mintUrl, method, category);
      return failedMintQuotePollingResult(normalizedIdentities, category, error);
    }
    if (!Array.isArray(response)) {
      if (useBatch) {
        this.recordDefinitiveBatchPollingFailure(mintUrl, method, 'malformed-response');
      }
      return failedMintQuotePollingResult(
        normalizedIdentities,
        'malformed-response',
        new ProofValidationError('Mint quote batch check returned a non-array response'),
      );
    }
    const snapshots = response;
    const selectedQuoteIds = new Set(normalizedIdentities.map((identity) => identity.quoteId));
    const snapshotsByQuoteId = new Map<
      string,
      Array<{ snapshot: MintMethodQuoteSnapshot; responseIndex: number }>
    >();
    const responseFailures: MintQuotePollingFailure[] = [];
    for (const [responseIndex, snapshot] of snapshots.entries()) {
      if (!snapshot || typeof snapshot !== 'object') {
        responseFailures.push({
          category: 'malformed-response',
          error: new ProofValidationError(
            `Mint quote batch response element ${responseIndex} has no identity`,
          ),
          responseIndex,
        });
        continue;
      }
      const responseQuoteId = (snapshot as { quote?: unknown }).quote;
      if (typeof responseQuoteId !== 'string' || responseQuoteId.length === 0) {
        responseFailures.push({
          category: 'malformed-response',
          error: new ProofValidationError(
            `Mint quote batch response element ${responseIndex} has no identity`,
          ),
          responseIndex,
        });
        continue;
      }
      if (!selectedQuoteIds.has(responseQuoteId)) {
        responseFailures.push({
          category: 'malformed-response',
          error: new ProofValidationError(
            `Mint quote batch response contains unselected quote ${responseQuoteId}`,
          ),
          responseIndex,
          responseQuoteId,
        });
        continue;
      }
      const candidates = snapshotsByQuoteId.get(responseQuoteId) ?? [];
      candidates.push({
        snapshot: {
          ...snapshot,
          pubkey: (snapshot as { pubkey?: unknown }).pubkey ?? undefined,
        } as MintMethodQuoteSnapshot,
        responseIndex,
      });
      snapshotsByQuoteId.set(responseQuoteId, candidates);
    }
    let hasDefinitiveBatchFailure = responseFailures.length > 0;
    const persisted: Array<{
      identity: QuoteIdentity;
      quote: MintQuote;
      remoteStateChanged: boolean;
    }> = [];
    const failedByQuoteId = new Map<string, MintQuotePollingFailure>();

    for (const identity of normalizedIdentities) {
      const candidates = snapshotsByQuoteId.get(identity.quoteId) ?? [];
      if (candidates.length === 0) {
        hasDefinitiveBatchFailure = true;
        failedByQuoteId.set(identity.quoteId, {
          category: 'malformed-response',
          error: new ProofValidationError(
            `Mint quote batch response is missing quote ${identity.quoteId}`,
          ),
          responseQuoteId: identity.quoteId,
        });
        continue;
      }

      const validCandidates: typeof candidates = [];
      const invalidCandidates: Array<{
        error: Error;
        responseIndex: number;
        definitive: boolean;
      }> = [];
      for (const candidate of candidates) {
        try {
          const snapshot = await this.assertAttributableMintQuotePollingSnapshot(
            mintUrl,
            method,
            identity.quoteId,
            candidate.snapshot,
          );
          validCandidates.push({ ...candidate, snapshot });
        } catch (error) {
          const normalizedError = normalizePollingError(error);
          invalidCandidates.push({
            error: normalizedError,
            responseIndex: candidate.responseIndex,
            definitive: isDefinitiveMintQuotePollingValidation(normalizedError),
          });
        }
      }

      if (validCandidates.length === 0) {
        if (invalidCandidates.some(({ definitive }) => definitive)) {
          hasDefinitiveBatchFailure = true;
        }
        const [firstFailure, ...additionalFailures] = invalidCandidates;
        failedByQuoteId.set(identity.quoteId, {
          category: 'validation',
          error: firstFailure!.error,
          responseQuoteId: identity.quoteId,
        });
        responseFailures.push(
          ...additionalFailures.map(({ error, responseIndex }) => ({
            category: 'validation' as const,
            error,
            responseIndex,
            responseQuoteId: identity.quoteId,
          })),
        );
        continue;
      }

      const firstValid = validCandidates[0]!;
      if (
        validCandidates.some(
          ({ snapshot }) =>
            !areMintQuotePollingSnapshotsEqual(method, firstValid.snapshot, snapshot),
        )
      ) {
        hasDefinitiveBatchFailure = true;
        failedByQuoteId.set(identity.quoteId, {
          category: 'malformed-response',
          error: new ProofValidationError(
            `Mint quote batch response contains conflicting duplicates for quote ${identity.quoteId}`,
          ),
          responseQuoteId: identity.quoteId,
        });
        continue;
      }

      if (validCandidates.length > 1 || invalidCandidates.some(({ definitive }) => definitive)) {
        hasDefinitiveBatchFailure = true;
      }
      responseFailures.push(
        ...validCandidates.slice(1).map(({ responseIndex }) => ({
          category: 'malformed-response' as const,
          error: new ProofValidationError(
            `Mint quote batch response contains duplicate quote ${identity.quoteId}`,
          ),
          responseIndex,
          responseQuoteId: identity.quoteId,
        })),
        ...invalidCandidates.map(({ error, responseIndex }) => ({
          category: 'validation' as const,
          error,
          responseIndex,
          responseQuoteId: identity.quoteId,
        })),
      );
      try {
        const result = await this.resolveAndPersistMintQuoteSnapshot(
          mintUrl,
          method,
          firstValid.snapshot,
        );
        persisted.push({ identity, ...result });
      } catch (error) {
        failedByQuoteId.set(identity.quoteId, {
          category: 'validation',
          error: normalizePollingError(error),
          responseQuoteId: identity.quoteId,
        });
      }
    }
    for (const result of persisted) {
      await this.emitMintQuoteUpdatedIfNeeded(result.quote, result.remoteStateChanged);
    }

    const persistedByQuoteId = new Map(
      persisted.map(({ identity, quote }) => [identity.quoteId, quote]),
    );
    const outcomes: MintQuotePollingOutcome[] = normalizedIdentities.map((identity) => {
      const quote = persistedByQuoteId.get(identity.quoteId);
      if (quote) return { status: 'updated', identity, quote };
      return { status: 'failed', identity, failure: failedByQuoteId.get(identity.quoteId)! };
    });
    const result = { outcomes, responseFailures };
    if (useBatch && hasDefinitiveBatchFailure) {
      this.markBatchUnavailableForPolling(mintUrl, method);
    }
    return result;
  }

  private async assertAttributableMintQuotePollingSnapshot(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    snapshot: MintMethodQuoteSnapshot,
  ): Promise<MintMethodQuoteSnapshot> {
    snapshot = assertMintQuotePollingSnapshotStructure(method, snapshot);
    const existing = await this.mintQuoteRepository.getMintQuoteById({ mintUrl, quoteId });
    if (!existing) {
      throw new ProofValidationError(
        `Mint quote ${quoteId} batch observation has no canonical quote`,
      );
    }
    if (existing.method !== method) {
      throw new QuoteIdentityConflictError('mint', mintUrl, quoteId, [method, existing.method]);
    }
    if (
      snapshot.quote !== quoteId ||
      snapshot.request !== existing.request ||
      normalizeUnit(snapshot.unit) !== existing.unit ||
      (snapshot.pubkey ?? undefined) !== (existing.pubkey ?? undefined)
    ) {
      throw new ProofValidationError(
        `Mint quote ${quoteId} batch observation conflicts with canonical identity fields`,
      );
    }

    if (existing.method === 'bolt11') {
      const amount = Amount.from(
        (snapshot as MintMethodQuoteSnapshot<'bolt11'>).amount as AmountLike,
      );
      if (!amount.equals(existing.amount)) {
        throw new ProofValidationError(
          `Mint quote ${quoteId} batch observation conflicts with canonical amount`,
        );
      }
      return snapshot;
    }

    if (existing.method === 'bolt12') {
      const incomingAmount = (snapshot as MintMethodQuoteSnapshot<'bolt12'>).amount;
      const existingAmount = existing.quoteData.amount;
      if (
        (incomingAmount == null) !== (existingAmount === undefined) ||
        (incomingAmount != null &&
          existingAmount !== undefined &&
          !Amount.from(incomingAmount as AmountLike).equals(existingAmount))
      ) {
        throw new ProofValidationError(
          `Mint quote ${quoteId} batch observation conflicts with canonical amount`,
        );
      }
    }
    return snapshot;
  }

  async refreshMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote> {
    const existingQuote = await this.mintQuoteRepository.getMintQuote(mintUrl, method, quoteId);
    if (!existingQuote) {
      throw new Error(`Mint quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    return this.refreshResolvedMintQuote(existingQuote);
  }

  async refreshMintQuoteById(identity: QuoteIdentity): Promise<MintQuote> {
    const existingQuote = await this.mintQuoteRepository.getMintQuoteById(identity);
    if (!existingQuote) {
      throw new Error(`Mint quote ${identity.quoteId} at ${identity.mintUrl} was not found`);
    }

    return this.refreshResolvedMintQuote(existingQuote);
  }

  async requireMintQuoteForPrepare(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    expectedUnit?: string,
  ): Promise<MintQuote> {
    const quote = await this.mintQuoteRepository.getMintQuote(mintUrl, method, quoteId);
    if (!quote) {
      throw new Error(`Mint quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    if (expectedUnit && quote.unit !== expectedUnit.toLowerCase()) {
      throw new Error(
        `Mint quote ${quoteId} unit ${quote.unit} does not match requested unit ${expectedUnit}`,
      );
    }

    this.assertMintQuoteCanPrepare(quote, `mint quote ${quoteId}`);
    return quote;
  }

  async requireMintQuoteRefForPrepare(ref: MintQuoteRef): Promise<MintQuote> {
    const quote = await this.mintQuoteRepository.getMintQuoteById({
      mintUrl: ref.mintUrl,
      quoteId: ref.quoteId,
    });
    if (!quote) {
      throw new Error(`Mint quote ${ref.quoteId} at ${ref.mintUrl} was not found`);
    }

    if (quote.method !== ref.method) {
      throw new QuoteIdentityConflictError(
        'mint',
        quote.mintUrl,
        quote.quoteId,
        [ref.method, quote.method],
        `Mint quote ${quote.quoteId} at ${quote.mintUrl} resolved to method ${quote.method}, not requested method ${ref.method}`,
      );
    }

    this.assertMintQuoteCanPrepare(quote, `mint quote ${ref.quoteId}`);
    return quote;
  }

  async loadMintQuoteSnapshotForOperation(op: InitMintOperation): Promise<MintMethodQuoteSnapshot> {
    if (!op.quoteId) {
      throw new Error(`Cannot prepare operation ${op.id}: no mint quote ID is attached`);
    }

    const quote = await this.mintQuoteRepository.getMintQuote(op.mintUrl, op.method, op.quoteId);
    if (!quote) {
      throw new Error(
        `Cannot prepare operation ${op.id}: mint quote ${op.quoteId} for ${op.method} at ${op.mintUrl} was not found`,
      );
    }

    this.assertMintQuoteCanPrepare(quote, `operation ${op.id} mint quote ${op.quoteId}`);

    const quoteAmount = getMintQuoteAmount(quote);
    if (quoteAmount && !quoteAmount.equals(op.amount)) {
      throw new Error(
        `Cannot prepare operation ${op.id}: mint quote ${op.quoteId} amount ${quoteAmount} does not match requested amount ${op.amount}`,
      );
    }

    if (quote.unit !== op.unit) {
      throw new Error(
        `Cannot prepare operation ${op.id}: mint quote ${op.quoteId} unit ${quote.unit} does not match requested unit ${op.unit}`,
      );
    }

    return mintQuoteToMethodSnapshot(quote);
  }

  async importMintQuote<M extends MintMethod>(
    mintUrl: string,
    method: M,
    quote: MintMethodQuoteSnapshot<M>,
  ): Promise<MintQuote<M>> {
    const normalizedMintUrl = normalizeMintUrl(mintUrl);
    const trusted = await this.mintService.isTrustedMint(normalizedMintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${normalizedMintUrl} is not trusted`);
    }

    const { quote: imported, remoteStateChanged } = await this.resolveAndPersistMintQuoteSnapshot(
      normalizedMintUrl,
      method,
      quote,
      (resolvedQuote) => this.assertMintQuoteCapabilities(resolvedQuote),
    );
    await this.emitMintQuoteUpdatedIfNeeded(imported, remoteStateChanged);
    return imported as MintQuote<M>;
  }

  private async resolveAndPersistMintQuoteSnapshot(
    mintUrl: string,
    method: MintMethod,
    quote: MintMethodQuoteSnapshot,
    beforePersist?: (quote: MintQuote) => Promise<void>,
  ): Promise<{ quote: MintQuote; remoteStateChanged: boolean }> {
    let canonicalQuote: MintQuote;

    if (method === 'bolt11') {
      const bolt11Quote = quote as MintMethodQuoteSnapshot<'bolt11'>;
      const rawAmount = (bolt11Quote as { amount?: unknown }).amount;
      if (rawAmount === undefined || rawAmount === null) {
        throw new ProofValidationError('Mint quote ' + bolt11Quote.quote + ' has invalid amount');
      }

      const amount = Amount.from(rawAmount as AmountLike);
      if (amount.isZero()) {
        throw new ProofValidationError('Mint quote ' + bolt11Quote.quote + ' has invalid amount');
      }

      canonicalQuote = mintQuoteFromBolt11Response(mintUrl, {
        ...bolt11Quote,
        amount,
      } as MintQuoteBolt11Response);
    } else if (method === 'onchain') {
      const onchainQuote = quote as MintMethodQuoteSnapshot<'onchain'>;
      canonicalQuote = mintQuoteFromOnchainResponse(mintUrl, {
        ...onchainQuote,
        amount_paid: onchainQuote.amount_paid ?? Amount.zero(),
        amount_issued: onchainQuote.amount_issued ?? Amount.zero(),
      });
    } else if (method === 'bolt12') {
      const bolt12Quote = quote as MintMethodQuoteSnapshot<'bolt12'>;
      canonicalQuote = mintQuoteFromBolt12Response(mintUrl, {
        ...bolt12Quote,
        amount_paid: bolt12Quote.amount_paid ?? Amount.zero(),
        amount_issued: bolt12Quote.amount_issued ?? Amount.zero(),
      } as MintQuoteBolt12Response);
    } else {
      throw new Error(`Unsupported mint quote import method ${String(method)}`);
    }

    const existing = await this.mintQuoteRepository.getMintQuote(
      canonicalQuote.mintUrl,
      canonicalQuote.method,
      canonicalQuote.quoteId,
    );
    if (
      existing &&
      isStatefulMintQuote(existing) &&
      isStatefulMintQuote(canonicalQuote) &&
      isMintQuoteStateDowngrade(existing.state, canonicalQuote.state)
    ) {
      await beforePersist?.(existing);
      return {
        quote: existing,
        remoteStateChanged: false,
      };
    }
    if (existing?.reusable && canonicalQuote.reusable) {
      canonicalQuote = {
        ...canonicalQuote,
        quoteData: {
          ...canonicalQuote.quoteData,
          amountPaid: maxAmount(existing.quoteData.amountPaid, canonicalQuote.quoteData.amountPaid),
          amountIssued: maxAmount(
            existing.quoteData.amountIssued,
            canonicalQuote.quoteData.amountIssued,
          ),
        },
      };
    }

    const remoteStateChanged = getRemoteStateChange(existing, canonicalQuote, quote);
    await beforePersist?.(canonicalQuote);
    const persisted = await this.persistCanonicalMintQuote(canonicalQuote);
    return { quote: persisted, remoteStateChanged };
  }

  async recordMintQuoteSnapshot(
    mintUrl: string,
    method: MintMethod,
    snapshot: MintMethodQuoteSnapshot,
  ): Promise<MintQuote> {
    const { quote, remoteStateChanged } = await this.resolveAndPersistMintQuoteSnapshot(
      mintUrl,
      method,
      snapshot,
    );
    await this.emitMintQuoteUpdatedIfNeeded(quote, remoteStateChanged);
    return quote;
  }

  async recordMintQuoteObservation(
    operation: PendingOrLaterOperation,
    state: MintMethodRemoteState,
    observedAt = Date.now(),
  ): Promise<MintQuote> {
    await this.ensureMintQuoteRecordForOperation(operation);
    const existing = await this.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    await this.mintQuoteRepository.setMintQuoteState(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
      state,
      observedAt,
    );
    const quote = await this.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (!quote) {
      throw new Error(
        `Cannot record quote observation: mint quote ${operation.quoteId} for ${operation.method} at ${operation.mintUrl} was not found`,
      );
    }

    await this.emitMintQuoteUpdatedIfNeeded(
      quote,
      !existing || getMintQuoteRemoteState(existing) !== getMintQuoteRemoteState(quote),
    );

    return quote;
  }

  async createMeltQuote<M extends MeltMethod>(
    mintUrl: string,
    method: M,
    methodData: MeltMethodInputData<M>,
    unit = DEFAULT_UNIT,
  ): Promise<MeltQuote<M>> {
    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const trusted = await this.mintService.isTrustedMint(mintUrl);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    }

    const normalizedMethodData = normalizeMeltMethodData(methodData);
    if (
      'amountSats' in normalizedMethodData &&
      normalizedMethodData.amountSats !== undefined &&
      normalizedMethodData.amountSats.isZero()
    ) {
      throw new ProofValidationError('Amount must be a positive number');
    }

    await this.mintService.assertMethodUnitSupported(mintUrl, 5, method, normalizedUnit);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      mintUrl,
      normalizedUnit,
    );

    const handler = this.meltHandlerProvider.get(method);
    const quote = await handler.createQuote({
      ...this.buildDeps(),
      mintUrl,
      methodData: normalizedMethodData,
      unit: normalizedUnit,
      wallet,
    });
    if (quote.unit !== normalizedUnit) {
      throw new ProofValidationError(
        `Melt quote ${quote.quoteId} unit ${quote.unit} does not match requested unit ${normalizedUnit}`,
      );
    }

    return (await this.recordMeltQuoteObservation(quote)) as MeltQuote<M>;
  }

  getMeltQuote(mintUrl: string, method: MeltMethod, quoteId: string): Promise<MeltQuote | null> {
    return this.meltQuoteRepository.getMeltQuote(mintUrl, method, quoteId);
  }

  getMeltQuoteById(identity: QuoteIdentity): Promise<MeltQuote | null> {
    return this.meltQuoteRepository.getMeltQuoteById(identity);
  }

  getPendingMeltQuotes(method?: MeltMethod): Promise<MeltQuote[]> {
    return this.meltQuoteRepository.getPendingMeltQuotes(method);
  }

  async refreshMeltQuote(mintUrl: string, method: MeltMethod, quoteId: string): Promise<MeltQuote> {
    const existingQuote = await this.meltQuoteRepository.getMeltQuote(mintUrl, method, quoteId);
    if (!existingQuote) {
      throw new Error(`Melt quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    return this.refreshResolvedMeltQuote(existingQuote);
  }

  async refreshMeltQuoteById(identity: QuoteIdentity): Promise<MeltQuote> {
    const existingQuote = await this.meltQuoteRepository.getMeltQuoteById(identity);
    if (!existingQuote) {
      throw new Error(`Melt quote ${identity.quoteId} at ${identity.mintUrl} was not found`);
    }

    return this.refreshResolvedMeltQuote(existingQuote);
  }

  async requireMeltQuoteForPrepare(
    mintUrl: string,
    method: MeltMethod,
    quoteId: string,
    expectedUnit?: string,
  ): Promise<MeltQuote> {
    const quote = await this.meltQuoteRepository.getMeltQuote(mintUrl, method, quoteId);
    if (!quote) {
      throw new Error(`Melt quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    if (expectedUnit && quote.unit !== normalizeUnit(expectedUnit, { defaultUnit: DEFAULT_UNIT })) {
      throw new Error(
        `Melt quote ${quoteId} unit ${quote.unit} does not match requested unit ${expectedUnit}`,
      );
    }

    this.assertMeltQuoteCanPrepare(quote, `melt quote ${quoteId}`);
    return quote;
  }

  async requireMeltQuoteRefForPrepare(ref: MeltQuoteRef): Promise<MeltQuote> {
    const quote = await this.meltQuoteRepository.getMeltQuoteById({
      mintUrl: ref.mintUrl,
      quoteId: ref.quoteId,
    });
    if (!quote) {
      throw new Error(`Melt quote ${ref.quoteId} at ${ref.mintUrl} was not found`);
    }

    if (quote.method !== ref.method) {
      throw new QuoteIdentityConflictError(
        'melt',
        quote.mintUrl,
        quote.quoteId,
        [ref.method, quote.method],
        `Melt quote ${quote.quoteId} at ${quote.mintUrl} resolved to method ${quote.method}, not requested method ${ref.method}`,
      );
    }

    this.assertMeltQuoteCanPrepare(quote, `melt quote ${ref.quoteId}`);
    return quote;
  }

  async loadMeltQuoteSnapshotForOperation(op: InitMeltOperation): Promise<MeltMethodQuoteSnapshot> {
    if (!op.quoteId) {
      throw new Error(`Cannot prepare operation ${op.id}: no melt quote ID is attached`);
    }

    const quote = await this.meltQuoteRepository.getMeltQuote(op.mintUrl, op.method, op.quoteId);
    if (!quote) {
      throw new Error(
        `Cannot prepare operation ${op.id}: melt quote ${op.quoteId} for ${op.method} at ${op.mintUrl} was not found`,
      );
    }

    this.assertMeltQuoteCanPrepare(quote, `operation ${op.id} melt quote ${op.quoteId}`);

    if (quote.unit !== op.unit) {
      throw new Error(
        `Cannot prepare operation ${op.id}: melt quote ${op.quoteId} unit ${quote.unit} does not match requested unit ${op.unit}`,
      );
    }

    return meltQuoteToMethodSnapshot(quote);
  }

  /**
   * Records a canonical melt quote observation and emits `melt-quote:updated` only when storage
   * changed meaningfully.
   */
  async recordMeltQuoteObservation(canonicalQuote: MeltQuote): Promise<MeltQuote> {
    const { quote, remoteQuoteChanged } =
      await this.resolveAndPersistMeltQuoteObservation(canonicalQuote);
    await this.emitMeltQuoteUpdatedIfNeeded(quote, remoteQuoteChanged);
    return quote;
  }

  private async resolveAndPersistMeltQuoteObservation(
    canonicalQuote: MeltQuote,
  ): Promise<{ quote: MeltQuote; remoteQuoteChanged: boolean }> {
    const existing = await this.meltQuoteRepository.getMeltQuote(
      canonicalQuote.mintUrl,
      canonicalQuote.method,
      canonicalQuote.quoteId,
    );

    if (existing?.state === 'PAID') {
      const enrichedQuote = mergePaidMeltQuoteSettlement(existing, canonicalQuote);
      if (enrichedQuote) {
        const persisted = await this.persistCanonicalMeltQuote(enrichedQuote);
        return {
          quote: persisted,
          remoteQuoteChanged: true,
        };
      }

      return {
        quote: existing,
        remoteQuoteChanged: false,
      };
    }

    const remoteQuoteChanged = getMeltQuoteChange(existing, canonicalQuote);
    if (!remoteQuoteChanged && existing) {
      return {
        quote: existing,
        remoteQuoteChanged: false,
      };
    }

    const persisted = await this.persistCanonicalMeltQuote(canonicalQuote);
    return { quote: persisted, remoteQuoteChanged };
  }

  private async persistCanonicalMintQuote(canonicalQuote: MintQuote): Promise<MintQuote> {
    await this.mintQuoteRepository.upsertMintQuote(canonicalQuote);
    return (
      (await this.mintQuoteRepository.getMintQuote(
        canonicalQuote.mintUrl,
        canonicalQuote.method,
        canonicalQuote.quoteId,
      )) ?? canonicalQuote
    );
  }

  private async emitMintQuoteUpdatedIfNeeded(
    quote: MintQuote,
    remoteStateChanged: boolean,
  ): Promise<void> {
    if (!remoteStateChanged) {
      return;
    }

    await this.eventBus.emit('mint-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });
  }

  private async persistCanonicalMeltQuote(canonicalQuote: MeltQuote): Promise<MeltQuote> {
    return this.meltQuoteRepository.upsertMeltQuote(canonicalQuote);
  }

  private async emitMeltQuoteUpdatedIfNeeded(
    quote: MeltQuote,
    remoteQuoteChanged: boolean,
  ): Promise<void> {
    if (!remoteQuoteChanged) {
      return;
    }

    await this.eventBus.emit('melt-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });
  }

  private async assertMintQuoteCapabilities(quote: MintQuote): Promise<void> {
    const amount = getMintQuoteAmount(quote);
    await this.mintService.assertMethodUnitSupported(
      quote.mintUrl,
      4,
      quote.method,
      amount ? { amount, unit: quote.unit } : quote.unit,
    );
  }

  private assertMintQuoteCanPrepare(quote: MintQuote, context: string): void {
    if (isMintQuoteExpired(quote)) {
      throw new Error(`Cannot prepare ${context}: quote is expired`);
    }

    if (isStatefulMintQuote(quote) && quote.state === 'ISSUED') {
      throw new Error(`Cannot prepare ${context}: quote is terminal`);
    }
  }

  private assertMeltQuoteCanPrepare(quote: MeltQuote, context: string): void {
    if (quote.expiry * 1000 <= Date.now()) {
      throw new Error(`Cannot prepare ${context}: quote is expired`);
    }

    if (quote.state !== 'UNPAID') {
      throw new Error(`Cannot prepare ${context}: quote is ${quote.state}`);
    }
  }

  private async ensureMintQuoteRecordForOperation(
    operation: PendingOrLaterOperation,
  ): Promise<void> {
    const existing = await this.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (existing) return;
    if (operation.method !== 'bolt11') {
      throw new Error(
        `Cannot create canonical quote record from ${operation.method} operation observation`,
      );
    }

    await this.mintQuoteRepository.upsertMintQuote({
      mintUrl: operation.mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
      quote: operation.quoteId,
      request: operation.request,
      unit: operation.unit,
      amount: operation.amount,
      expiry: operation.expiry,
      pubkey: operation.pubkey,
      state: 'UNPAID',
      reusable: false,
      quoteData: {
        amount: operation.amount,
      },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }
}
