import { Amount, type AmountLike } from '@cashu/cashu-ts';
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
  assertValidMintQuoteAccounting,
  deriveMintQuoteAccountingFromState,
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
  mintQuoteToMethodSnapshot,
  isStatefulMintQuote,
  type MintQuote,
} from '../models/MintQuote';
import { meltQuoteToMethodSnapshot, type MeltQuote } from '../models/MeltQuote';
import {
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

function getMintQuoteAccountingSum(quote: Pick<MintQuote, 'amountPaid' | 'amountIssued'>): Amount {
  return quote.amountPaid.add(quote.amountIssued);
}

function getMintQuoteTerminalCompatibilityState(quote: MintQuote): 'ISSUED' | null {
  return isStatefulMintQuote(quote) && quote.state === 'ISSUED' ? quote.state : null;
}

function serializeOptionalAmount(amount: Amount | null | undefined): string | null {
  return amount?.toString() ?? null;
}

function getMeaningfulMintQuoteFields(quote: MintQuote): unknown {
  const base = {
    method: quote.method,
    quoteId: quote.quoteId,
    request: quote.request,
    unit: quote.unit,
    expiry: quote.expiry,
    pubkey: quote.pubkey ?? null,
    reusable: quote.reusable,
    amountPaid: quote.amountPaid.toString(),
    amountIssued: quote.amountIssued.toString(),
    claimableAmount: quote.amountPaid.greaterThan(quote.amountIssued)
      ? quote.amountPaid.subtract(quote.amountIssued).toString()
      : '0',
    terminalCompatibilityState: getMintQuoteTerminalCompatibilityState(quote),
  };

  if (quote.method === 'bolt11') {
    return {
      ...base,
      amount: quote.amount.toString(),
    };
  }

  if (quote.method === 'onchain') {
    return {
      ...base,
      quoteData: {
        pubkey: quote.quoteData.pubkey,
        amountPaid: quote.quoteData.amountPaid.toString(),
        amountIssued: quote.quoteData.amountIssued.toString(),
      },
    };
  }

  return {
    ...base,
    amount: serializeOptionalAmount(quote.amount),
    quoteData: {
      pubkey: quote.quoteData.pubkey,
      amount: serializeOptionalAmount(quote.quoteData.amount),
      amountPaid: quote.quoteData.amountPaid.toString(),
      amountIssued: quote.quoteData.amountIssued.toString(),
    },
  };
}

function getMintQuoteChange(existing: MintQuote | null, incoming: MintQuote): boolean {
  if (!existing) {
    return true;
  }

  if (existing.method !== incoming.method || existing.quoteId !== incoming.quoteId) {
    return true;
  }

  return (
    JSON.stringify(getMeaningfulMintQuoteFields(existing)) !==
    JSON.stringify(getMeaningfulMintQuoteFields(incoming))
  );
}

interface MintQuoteObservationResolution {
  quote: MintQuote;
  remoteQuoteChanged: boolean;
  shouldPersist: boolean;
}

function resolveMintQuoteObservation(
  existing: MintQuote | null,
  incoming: MintQuote,
  options: {
    logger?: Logger;
  } = {},
): MintQuoteObservationResolution {
  const logIgnoredObservation = (message: string): void => {
    options.logger?.warn(message, {
      mintUrl: incoming.mintUrl,
      method: incoming.method,
      quoteId: incoming.quoteId,
      existingRemoteUpdatedAt: existing?.remoteUpdatedAt ?? null,
      incomingRemoteUpdatedAt: incoming.remoteUpdatedAt,
      existingAmountPaid: existing?.amountPaid.toString(),
      existingAmountIssued: existing?.amountIssued.toString(),
      incomingAmountPaid: incoming.amountPaid.toString(),
      incomingAmountIssued: incoming.amountIssued.toString(),
    });
  };

  if (incoming.amountIssued.greaterThan(incoming.amountPaid)) {
    logIgnoredObservation('Ignoring mint quote observation with invalid accounting');
    return {
      quote: existing ?? incoming,
      remoteQuoteChanged: false,
      shouldPersist: false,
    };
  }

  if (existing) {
    if (existing.remoteUpdatedAt !== null && incoming.remoteUpdatedAt !== null) {
      if (incoming.remoteUpdatedAt < existing.remoteUpdatedAt) {
        return {
          quote: existing,
          remoteQuoteChanged: false,
          shouldPersist: false,
        };
      }

      if (
        incoming.remoteUpdatedAt === existing.remoteUpdatedAt &&
        (!existing.amountPaid.equals(incoming.amountPaid) ||
          !existing.amountIssued.equals(incoming.amountIssued))
      ) {
        logIgnoredObservation(
          'Ignoring mint quote observation with conflicting accounting at unchanged remote update time',
        );
        return {
          quote: existing,
          remoteQuoteChanged: false,
          shouldPersist: false,
        };
      }
    } else {
      const existingFreshness = getMintQuoteAccountingSum(existing);
      const incomingFreshness = getMintQuoteAccountingSum(incoming);
      const acceptedByFallback =
        incomingFreshness.greaterThan(existingFreshness) &&
        !incoming.amountPaid.lessThan(existing.amountPaid) &&
        !incoming.amountIssued.lessThan(existing.amountIssued);

      if (!acceptedByFallback) {
        return {
          quote: existing,
          remoteQuoteChanged: false,
          shouldPersist: false,
        };
      }
    }
  }

  return {
    quote: incoming,
    remoteQuoteChanged: getMintQuoteChange(existing, incoming),
    shouldPersist: true,
  };
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

    const { quote, remoteQuoteChanged } =
      await this.resolveAndPersistMintQuoteObservation(refreshed);
    await this.emitMintQuoteUpdatedIfNeeded(quote, remoteQuoteChanged);
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

    const { quote: imported, remoteQuoteChanged } = await this.resolveAndPersistMintQuoteSnapshot(
      normalizedMintUrl,
      method,
      quote,
      async (resolvedQuote) => {
        assertValidMintQuoteAccounting(
          resolvedQuote.quoteId,
          resolvedQuote.amountPaid,
          resolvedQuote.amountIssued,
        );
        await this.assertMintQuoteCapabilities(resolvedQuote);
      },
    );
    await this.emitMintQuoteUpdatedIfNeeded(imported, remoteQuoteChanged);
    return imported as MintQuote<M>;
  }

  private async resolveAndPersistMintQuoteSnapshot(
    mintUrl: string,
    method: MintMethod,
    quote: MintMethodQuoteSnapshot,
    beforePersist?: (quote: MintQuote) => Promise<void>,
  ): Promise<{ quote: MintQuote; remoteQuoteChanged: boolean }> {
    const canonicalQuote = this.mintQuoteFromSnapshot(mintUrl, method, quote);
    return this.resolveAndPersistMintQuoteObservation(canonicalQuote, {
      beforePersist,
    });
  }

  private mintQuoteFromSnapshot(
    mintUrl: string,
    method: MintMethod,
    quote: MintMethodQuoteSnapshot,
  ): MintQuote {
    const snapshotMethod = (quote as { method?: unknown }).method;
    if (snapshotMethod !== undefined && snapshotMethod !== method) {
      throw new ProofValidationError(
        `Mint quote ${quote.quote} reported method ${String(snapshotMethod)}, not ${method}`,
      );
    }

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

      return mintQuoteFromBolt11Response(mintUrl, {
        ...bolt11Quote,
        amount,
      });
    }

    if (method === 'onchain') {
      const onchainQuote = quote as MintMethodQuoteSnapshot<'onchain'>;
      return mintQuoteFromOnchainResponse(mintUrl, onchainQuote);
    }

    if (method === 'bolt12') {
      const bolt12Quote = quote as MintMethodQuoteSnapshot<'bolt12'>;
      return mintQuoteFromBolt12Response(mintUrl, bolt12Quote);
    }

    throw new Error(`Unsupported mint quote import method ${String(method)}`);
  }

  private async resolveAndPersistMintQuoteObservation(
    canonicalQuote: MintQuote,
    options: {
      beforePersist?: (quote: MintQuote) => Promise<void>;
    } = {},
  ): Promise<{ quote: MintQuote; remoteQuoteChanged: boolean }> {
    await options.beforePersist?.(canonicalQuote);

    const existing = await this.mintQuoteRepository.getMintQuote(
      canonicalQuote.mintUrl,
      canonicalQuote.method,
      canonicalQuote.quoteId,
    );

    const resolution = resolveMintQuoteObservation(existing, canonicalQuote, {
      logger: this.logger,
    });

    if (!resolution.shouldPersist) {
      return {
        quote: resolution.quote,
        remoteQuoteChanged: resolution.remoteQuoteChanged,
      };
    }

    const persisted = await this.persistCanonicalMintQuote(resolution.quote);
    return { quote: persisted, remoteQuoteChanged: resolution.remoteQuoteChanged };
  }

  private async resolveAndPersistMintQuoteStateObservation(
    existing: MintQuote<'bolt11'>,
    state: MintMethodRemoteState<'bolt11'>,
    observedAt: number,
  ): Promise<{ quote: MintQuote; remoteQuoteChanged: boolean }> {
    const resolution = resolveMintQuoteObservation(
      existing,
      {
        ...existing,
        state,
        ...deriveMintQuoteAccountingFromState(state, existing.amount),
        remoteUpdatedAt: null,
        updatedAt: observedAt,
      },
      {
        logger: this.logger,
      },
    );

    if (!resolution.shouldPersist || !isStatefulMintQuote(resolution.quote)) {
      return {
        quote: resolution.quote,
        remoteQuoteChanged: resolution.remoteQuoteChanged,
      };
    }

    await this.mintQuoteRepository.setMintQuoteState(
      resolution.quote.mintUrl,
      resolution.quote.method,
      resolution.quote.quoteId,
      resolution.quote.state,
      observedAt,
    );
    const persisted = await this.mintQuoteRepository.getMintQuote(
      resolution.quote.mintUrl,
      resolution.quote.method,
      resolution.quote.quoteId,
    );
    if (!persisted) {
      throw new Error(
        `Cannot record quote observation: mint quote ${resolution.quote.quoteId} for ${resolution.quote.method} at ${resolution.quote.mintUrl} was not found after persistence`,
      );
    }

    return { quote: persisted, remoteQuoteChanged: resolution.remoteQuoteChanged };
  }

  async recordMintQuoteSnapshot(
    mintUrl: string,
    method: MintMethod,
    snapshot: MintMethodQuoteSnapshot,
  ): Promise<MintQuote> {
    const { quote, remoteQuoteChanged } = await this.resolveAndPersistMintQuoteSnapshot(
      mintUrl,
      method,
      snapshot,
    );
    await this.emitMintQuoteUpdatedIfNeeded(quote, remoteQuoteChanged);
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
    if (!existing) {
      throw new Error(
        `Cannot record quote observation: mint quote ${operation.quoteId} for ${operation.method} at ${operation.mintUrl} was not found`,
      );
    }

    if (!isStatefulMintQuote(existing)) {
      return existing;
    }

    const { quote, remoteQuoteChanged } = await this.resolveAndPersistMintQuoteStateObservation(
      existing,
      state,
      observedAt,
    );

    await this.emitMintQuoteUpdatedIfNeeded(quote, remoteQuoteChanged);

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
    remoteQuoteChanged: boolean,
  ): Promise<void> {
    if (!remoteQuoteChanged) {
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
    await this.meltQuoteRepository.upsertMeltQuote(canonicalQuote);
    const quote = await this.meltQuoteRepository.getMeltQuote(
      canonicalQuote.mintUrl,
      canonicalQuote.method,
      canonicalQuote.quoteId,
    );
    if (!quote) {
      throw new Error(
        `Cannot persist quote observation: melt quote ${canonicalQuote.quoteId} for ${canonicalQuote.method} at ${canonicalQuote.mintUrl} was not found after persistence`,
      );
    }
    return quote;
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
    if (quote.expiry !== null && quote.expiry * 1000 <= Date.now()) {
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
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
      remoteUpdatedAt: null,
      quoteData: {
        amount: operation.amount,
      },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }
}
