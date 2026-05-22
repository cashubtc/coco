import type { MintQuoteBolt11Response } from '@cashu/cashu-ts';
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
  mintQuoteFromBolt11Response,
  mintQuoteToMethodSnapshot,
  isStatefulMintQuote,
  type MintQuote,
} from '../models/MintQuote';
import { meltQuoteToMethodSnapshot, type MeltQuote } from '../models/MeltQuote';
import { ProofValidationError, UnknownMintError } from '../models/Error';
import type { MeltQuoteRepository, MintQuoteRepository, ProofRepository } from '../repositories';
import type { MintService } from '../services/MintService';
import type { ProofService } from '../services/ProofService';
import type { WalletService } from '../services/WalletService';
import type { InitMeltOperation } from '../operations/melt/MeltOperation';
import type {
  MeltMethod,
  MeltMethodData,
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

const MINT_QUOTE_STATE_RANK: Record<string, number> = {
  UNPAID: 0,
  PAID: 1,
  ISSUED: 2,
};

function isMintQuoteStateDowngrade(
  existing: MintMethodRemoteState,
  incoming: MintMethodRemoteState,
): boolean {
  return (MINT_QUOTE_STATE_RANK[incoming] ?? 0) < (MINT_QUOTE_STATE_RANK[existing] ?? 0);
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
      'amount' in createQuoteData ? normalizeUnitAmount(createQuoteData.amount) : undefined;
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
    return persistedQuote;
  }

  getMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote | null> {
    return this.mintQuoteRepository.getMintQuote(mintUrl, method, quoteId);
  }

  getPendingMintQuotes(method?: MintMethod): Promise<MintQuote[]> {
    return this.mintQuoteRepository.getPendingMintQuotes(method);
  }

  async refreshMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote> {
    const existingQuote = await this.mintQuoteRepository.getMintQuote(mintUrl, method, quoteId);
    if (!existingQuote) {
      throw new Error(`Mint quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    const handler = this.mintHandlerProvider.get(method);
    const refreshed = await handler.fetchRemoteQuote({
      ...this.buildDeps(),
      quote: existingQuote,
    });

    await this.mintQuoteRepository.upsertMintQuote(refreshed);
    const quote = await this.mintQuoteRepository.getMintQuote(
      existingQuote.mintUrl,
      method,
      quoteId,
    );
    if (!quote) {
      throw new Error(
        `Cannot refresh quote: mint quote ${quoteId} for ${method} at ${mintUrl} was not found after persistence`,
      );
    }

    await this.eventBus.emit('mint-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });

    return quote;
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
    if (!quoteAmount) {
      throw new Error(
        `Cannot prepare operation ${op.id}: mint quote ${op.quoteId} for ${op.method} does not have a fixed amount`,
      );
    }

    if (!quoteAmount.equals(op.amount)) {
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

  async importMintQuoteSnapshot(
    mintUrl: string,
    method: MintMethod,
    quote: MintMethodQuoteSnapshot,
  ): Promise<MintQuote> {
    if (method !== 'bolt11') {
      throw new Error(`Unsupported mint quote import method ${String(method)}`);
    }

    const bolt11Quote = quote as MintMethodQuoteSnapshot<'bolt11'>;
    if (!bolt11Quote.amount || bolt11Quote.amount.isZero()) {
      throw new ProofValidationError(`Mint quote ${bolt11Quote.quote} has invalid amount`);
    }

    const canonicalQuote = mintQuoteFromBolt11Response(
      mintUrl,
      bolt11Quote as MintQuoteBolt11Response,
    );
    const existing = await this.mintQuoteRepository.getMintQuote(
      canonicalQuote.mintUrl,
      canonicalQuote.method,
      canonicalQuote.quoteId,
    );
    if (
      existing &&
      isStatefulMintQuote(existing) &&
      isMintQuoteStateDowngrade(existing.state, canonicalQuote.state)
    ) {
      return existing;
    }

    await this.mintQuoteRepository.upsertMintQuote(canonicalQuote);
    return (
      (await this.mintQuoteRepository.getMintQuote(
        canonicalQuote.mintUrl,
        canonicalQuote.method,
        canonicalQuote.quoteId,
      )) ?? canonicalQuote
    );
  }

  async recordMintQuoteObservation(
    operation: PendingOrLaterOperation,
    state: MintMethodRemoteState,
    observedAt = Date.now(),
  ): Promise<MintQuote> {
    await this.ensureMintQuoteRecordForOperation(operation);
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

    await this.eventBus.emit('mint-quote:updated', {
      mintUrl: quote.mintUrl,
      method: quote.method,
      quoteId: quote.quoteId,
      quote,
    });

    return quote;
  }

  async createMeltQuote(
    mintUrl: string,
    method: MeltMethod,
    methodData: MeltMethodInputData,
    unit = DEFAULT_UNIT,
  ): Promise<MeltQuote> {
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

    await this.meltQuoteRepository.upsertMeltQuote(quote);
    return (await this.meltQuoteRepository.getMeltQuote(mintUrl, method, quote.quoteId)) ?? quote;
  }

  getMeltQuote(mintUrl: string, method: MeltMethod, quoteId: string): Promise<MeltQuote | null> {
    return this.meltQuoteRepository.getMeltQuote(mintUrl, method, quoteId);
  }

  getPendingMeltQuotes(method?: MeltMethod): Promise<MeltQuote[]> {
    return this.meltQuoteRepository.getPendingMeltQuotes(method);
  }

  async refreshMeltQuote(mintUrl: string, method: MeltMethod, quoteId: string): Promise<MeltQuote> {
    const existingQuote = await this.meltQuoteRepository.getMeltQuote(mintUrl, method, quoteId);
    if (!existingQuote) {
      throw new Error(`Melt quote ${quoteId} for ${method} at ${mintUrl} was not found`);
    }

    const handler = this.meltHandlerProvider.get(method);
    const refreshed = await handler.fetchRemoteQuote({
      ...this.buildDeps(),
      quote: existingQuote,
    });

    await this.meltQuoteRepository.upsertMeltQuote(refreshed);
    const quote = await this.meltQuoteRepository.getMeltQuote(
      existingQuote.mintUrl,
      method,
      quoteId,
    );
    if (!quote) {
      throw new Error(
        `Cannot refresh quote: melt quote ${quoteId} for ${method} at ${mintUrl} was not found after persistence`,
      );
    }
    return quote;
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

  methodDataFromMeltQuote(quote: MeltQuote): MeltMethodData {
    switch (quote.method) {
      case 'bolt11':
        return { invoice: quote.request };
      default:
        throw new Error(`Unsupported melt quote method ${String(quote.method)}`);
    }
  }

  private assertMintQuoteCanPrepare(quote: MintQuote, context: string): void {
    if (quote.reusable) {
      throw new Error(`Cannot prepare ${context}: reusable quote is unsupported`);
    }

    if (quote.expiry !== null && quote.expiry * 1000 <= Date.now()) {
      throw new Error(`Cannot prepare ${context}: quote is expired`);
    }

    if (quote.state === 'ISSUED') {
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
      state: operation.lastObservedRemoteState ?? 'UNPAID',
      lastObservedRemoteState: operation.lastObservedRemoteState,
      lastObservedRemoteStateAt: operation.lastObservedRemoteStateAt,
      reusable: false,
      quoteData: {
        amount: operation.amount,
      },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    });
  }
}
