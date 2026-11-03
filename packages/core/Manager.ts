import type { OutputDataCreator } from '@cashu/cashu-ts';
import { StoredMintQueries } from './mints/MintMetadata.ts';
import { StoredBalanceQueries, type BalanceQueries } from './proofs/BalanceQueries.ts';
import { CashuSendRemote } from './infra/handlers/send/CashuSendRemote.ts';
import type {
  Repositories,
  LegacyMintQuoteRepository,
  MintOperationRepository,
  SendOperationRepository,
  MeltOperationRepository,
  ReceiveOperationRepository,
  PaymentRequestReceiveOperationRepository,
  PaymentRequestReceiveAttemptRepository,
} from './repositories';
import {
  MintService,
  MintOperationWatcherService,
  MintOperationProcessor,
  MeltQuoteWatcherService,
  MeltSettlementProcessor,
  WalletService,
  SeedService,
  WalletRestoreService,
  ProofStateWatcherService,
  HistoryService,
  KeyRingService,
  PaymentRequestService,
  PaymentRequestReceiveService,
  AuthSessionService,
  AuthService,
  TokenService,
} from './services';
import { SendOperationService } from './operations/send/SendOperationService';
import { MeltOperationService } from './operations/melt/MeltOperationService';
import { MintOperationService } from './operations/mint/MintOperationService';
import { CashuReceiveRemote } from './infra/handlers/receive/CashuReceiveRemote.ts';
import { ReceiveOperationService } from './operations/receive/ReceiveOperationService';
import { MintScopedLock } from './operations/MintScopedLock';
import { OperationIdLock } from './operations/OperationIdLock.ts';
import { MintSwapOperationService } from './operations/mintSwap/MintSwapOperationService.ts';
import { BatchMintOperationService } from './operations/batchMint/BatchMintOperationService.ts';
import { BatchMintQuoteClaims } from './operations/batchMint/BatchMintQuoteClaims.ts';
import type { MintSwapOperationRepository } from './operations/mintSwap/MintSwapOperationRepository.ts';
import {
  MintSwapOperationProcessor,
  validateMintSwapProcessorOptions,
  type MintSwapOperationProcessorOptions,
} from './services/watchers/MintSwapOperationProcessor.ts';
import {
  SubscriptionManager,
  type WebSocketFactory,
  PollingTransport,
  MintAdapter,
  MintRequestProvider,
  MeltBolt11Handler,
  MeltBolt12Handler,
  MeltOnchainHandler,
  MeltHandlerProvider,
  SendHandlerProvider,
  DefaultSendHandler,
  P2pkSendHandler,
  MintBolt11Handler,
  MintBolt12Handler,
  MintHandlerProvider,
  MintOnchainHandler,
  PaymentRequestReceiveTransportHandlerProvider,
} from './infra';
import { EventBus, type CoreEvents } from './events';
import { type Logger, NullLogger } from './logging';
import {
  MintApi,
  WalletApi,
  HistoryApi,
  KeyRingApi,
  AuthApi,
  OpsApi,
  SendOpsApi,
  ReceiveOpsApi,
  MeltOpsApi,
  MintOpsApi,
  BatchMintOpsApi,
  MintSwapOpsApi,
  QuoteApi,
  PaymentRequestsApi,
} from './api';
import { PluginHost } from './plugins/PluginHost.ts';
import type { MintMethodQuoteSnapshot } from './operations/mint';
import type { Plugin, PluginExtensions, ServiceMap } from './plugin.ts';
import { QuoteLifecycle } from './quotes/QuoteLifecycle.ts';
import {
  getMintQuoteAmount,
  isStatefulMintQuote,
  mintQuoteToMethodSnapshot,
} from './models/MintQuote.ts';
import { assessMintQuoteClaimability } from './models/MintQuoteClaimability.ts';
import {
  RepositoryCoreTransactionRunner,
  type CoreTransactionRunner,
} from './transactions/CoreTransaction.ts';
import { KeypairDerivation } from './keypairs/KeypairDerivation.ts';
import { KeypairP2pkSigner } from './keypairs/P2pkSigner.ts';

export type { MintSwapOperationProcessorOptions } from './services/watchers/MintSwapOperationProcessor.ts';

function validateMintSwapProcessorConfiguration(
  processor?: MintSwapOperationProcessorOptions & { disabled?: boolean },
): void {
  if (processor?.disabled !== undefined && typeof processor.disabled !== 'boolean')
    throw new TypeError('mintSwapOperationProcessor.disabled must be boolean');
  validateMintSwapProcessorOptions(processor ?? {});
}

/**
 * Configuration options for initializing the Coco Cashu manager
 */
export interface CocoConfig {
  /** Repository implementations for data persistence */
  repo: Repositories;
  /** Function that returns the wallet seed as Uint8Array */
  seedGetter: () => Promise<Uint8Array>;
  /** Optional logger instance (defaults to NullLogger) */
  logger?: Logger;
  /** Optional WebSocket factory for real-time subscriptions */
  webSocketFactory?: WebSocketFactory;
  /** Optional plugins to extend functionality */
  plugins?: Plugin[];
  /**
   * Optional session-wide strategy used only to construct Cashu output material.
   * Defaults to the standard cashu-ts implementation.
   *
   * This does not customize persisted output reconstruction or guarantee custom proof conversion
   * after serialization. Coco persists only the standard `OutputDataLike` fields and may later
   * reconstruct a cashu-ts `OutputData`, whose built-in `toProof()` implementation is then used. A
   * custom result must still satisfy `OutputDataLike`, but its object identity and `toProof()`
   * implementation are not preserved across serialization.
   */
  outputDataCreator?: OutputDataCreator;
  /**
   * Session-lifetime watcher selection and options (all enabled by default)
   * - Omit to use defaults (enabled)
   * - Set `disabled: true` to omit this owner for the entire session
   * - Provide options to customize behavior
   */
  watchers?: {
    /** Mint operation watcher (enabled by default) */
    mintOperationWatcher?: {
      disabled?: boolean;
      watchExistingPendingOnStart?: boolean;
      watchExistingPendingQuotesOnStart?: boolean;
    };
    /** Proof state watcher (enabled by default) */
    proofStateWatcher?: {
      disabled?: boolean;
      /** Scan pending Sends and their proofs on start (default: true). */
      watchExistingInflightOnStart?: boolean;
    };
    /** Melt quote watcher (enabled by default) */
    meltQuoteWatcher?: {
      disabled?: boolean;
      watchExistingPendingQuotesOnStart?: boolean;
    };
  };
  /**
   * Session-lifetime processor selection and options (all enabled by default)
   * - Omit to use defaults (enabled)
   * - Set `disabled: true` to omit this owner for the entire session
   * - Provide options to customize behavior
   */
  processors?: {
    /** Automatic recovery of persisted swaps; enabled by default. Explicit commands remain available. */
    mintSwapOperationProcessor?: MintSwapOperationProcessorOptions & { disabled?: boolean };
    /** Mint operation processor (enabled by default) */
    mintOperationProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      maxRetries?: number;
      baseRetryDelayMs?: number;
      initialEnqueueDelayMs?: number;
      /** Automatically claim cached and newly observed Mint Quote value (default: true). */
      autoClaimMintQuotes?: boolean;
      /**
       * Claim compatible quotes together through Batch Mint Operations (default `true`). `false`
       * claims one standalone Mint Operation per quote; `ops.mint.batch` stays available.
       */
      batchMintQuotes?: boolean;
    };
    /** Melt settlement processor (enabled by default) */
    meltSettlementProcessor?: {
      disabled?: boolean;
      /** Discover pending Melts from persisted evidence; live listeners remain enabled. */
      initializeExistingPendingOperationsOnStart?: boolean;
    };
  };
  /**
   * Subscription transport configuration
   * Controls the hybrid WebSocket + polling behavior
   */
  subscriptions?: {
    /**
     * Polling interval (ms) while WebSocket is connected.
     * Only used as backup to catch silent WS failures.
     * Default: 20000 (20 seconds)
     */
    slowPollingIntervalMs?: number;
    /**
     * Polling interval (ms) after WebSocket fails.
     * Used as primary transport when WS is unavailable.
     * Default: 5000 (5 seconds)
     */
    fastPollingIntervalMs?: number;
  };
  /**
   * Per-mint limit on outgoing HTTP requests, as a token bucket: up to `capacity` requests may be
   * sent at once, then requests queue and are released as tokens refill. Limits apply to each mint
   * independently.
   * - Omit to use the defaults (`capacity: 20`, `refillPerMinute: 20`)
   * - Set `disabled: true` to send requests without queueing
   */
  requestRateLimit?: {
    disabled?: boolean;
    /** Maximum burst size (default: 20) */
    capacity?: number;
    /** Sustained request rate (default: 20) */
    refillPerMinute?: number;
  };
}

export type CocoInitializationCleanupState = 'confirmed' | 'unconfirmed';

/**
 * Reports a failed `initializeCoco()` call and whether its partially initialized Manager was
 * disposed successfully.
 */
export class CocoInitializationError extends Error {
  constructor(
    message: string,
    readonly cleanupState: CocoInitializationCleanupState,
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = 'CocoInitializationError';
  }
}

const initializeSession = Symbol('initializeSession');

/**
 * Initializes and configures a new Coco Cashu manager instance
 * @param config - Configuration options including repositories, seed, and optional features
 * @returns A fully initialized Manager instance
 */
export async function initializeCoco(config: CocoConfig): Promise<Manager> {
  validateMintSwapProcessorConfiguration(config.processors?.mintSwapOperationProcessor);
  await config.repo.init();
  const coco = new Manager(
    config.repo,
    config.seedGetter,
    config.logger,
    config.webSocketFactory,
    config.plugins,
    config.watchers,
    config.processors,
    config.subscriptions,
    config.outputDataCreator,
    config.requestRateLimit,
  );

  try {
    await coco[initializeSession]();

    return coco;
  } catch (error) {
    try {
      await coco.dispose();
    } catch (cleanupError) {
      throw new CocoInitializationError(
        'Coco initialization failed and cleanup could not be confirmed',
        'unconfirmed',
        new AggregateError([error, cleanupError]),
      );
    }
    throw new CocoInitializationError('Coco initialization failed', 'confirmed', error);
  }
}

export class Manager {
  readonly mint: MintApi;
  readonly wallet: WalletApi;
  readonly keyring: KeyRingApi;
  readonly history: HistoryApi;
  readonly auth: AuthApi;
  readonly ops: OpsApi;
  readonly quotes: QuoteApi;
  readonly paymentRequests: PaymentRequestsApi;
  readonly ext: PluginExtensions;
  private mintService: MintService;
  private walletService: WalletService;
  private walletRestoreService: WalletRestoreService;
  private keyRingService: KeyRingService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;
  readonly subscriptions: SubscriptionManager;
  private readonly mintOperationWatcher?: MintOperationWatcherService;
  private readonly mintOperationProcessor?: MintOperationProcessor;
  private readonly mintSwapOperationProcessor?: MintSwapOperationProcessor;
  private mintSwapOperationService: MintSwapOperationService;
  private mintSwapOperationRepository: MintSwapOperationRepository;
  private readonly mintSwapDisposal = new AbortController();
  private readonly meltQuoteWatcher?: MeltQuoteWatcherService;
  private readonly meltSettlementProcessor?: MeltSettlementProcessor;
  private legacyMintQuoteRepository: LegacyMintQuoteRepository;
  private quoteLifecycle: QuoteLifecycle;
  private readonly proofStateWatcher?: ProofStateWatcherService;
  private historyService: HistoryService;
  private seedService: SeedService;
  private tokenService: TokenService;
  private paymentRequestService: PaymentRequestService;
  private paymentRequestReceiveService: PaymentRequestReceiveService;
  private authSessionService: AuthSessionService;
  private authService: AuthService;
  private sendOperationService: SendOperationService;
  private sendOperationRepository: SendOperationRepository;
  private meltOperationService: MeltOperationService;
  private meltOperationRepository: MeltOperationRepository;
  private mintOperationService: MintOperationService;
  private batchMintOperationService: BatchMintOperationService;
  private batchMintQuoteClaims: BatchMintQuoteClaims;
  private mintOperationRepository: MintOperationRepository;
  private receiveOperationService: ReceiveOperationService;
  private receiveOperationRepository: ReceiveOperationRepository;
  private paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  private paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  private proofRepository: Repositories['proofRepository'];
  private balanceQueries: BalanceQueries;
  private transactionRunner: CoreTransactionRunner;
  private readonly pluginHost: PluginHost = new PluginHost();
  private subscriptionRepair?: Promise<void>;
  private readonly mintRequestProvider: MintRequestProvider;
  private readonly mintAdapter: MintAdapter;
  private disposed = false;
  private disposePromise?: Promise<void>;
  private readonly outputDataCreator?: OutputDataCreator;
  constructor(
    repositories: Repositories,
    seedGetter: () => Promise<Uint8Array>,
    logger?: Logger,
    webSocketFactory?: WebSocketFactory,
    plugins?: Plugin[],
    watchers?: CocoConfig['watchers'],
    processors?: CocoConfig['processors'],
    subscriptions?: CocoConfig['subscriptions'],
    outputDataCreator?: OutputDataCreator,
    requestRateLimit?: CocoConfig['requestRateLimit'],
  ) {
    validateMintSwapProcessorConfiguration(processors?.mintSwapOperationProcessor);
    this.mintSwapOperationRepository = repositories.mintSwap.operationRepository;
    this.logger = logger ?? new NullLogger();
    this.eventBus = this.createEventBus();
    this.outputDataCreator = outputDataCreator;

    // Create shared request provider and mint adapter first
    // These are shared across WalletService and SubscriptionManager (polling)
    this.mintRequestProvider = new MintRequestProvider({
      capacity: requestRateLimit?.capacity ?? 20,
      refillPerMinute: requestRateLimit?.refillPerMinute ?? 20,
      disabled: requestRateLimit?.disabled,
      logger: this.getChildLogger('RequestRateLimiter'),
    });
    this.mintAdapter = new MintAdapter(
      this.mintRequestProvider,
      this.getChildLogger('MintAdapter'),
    );

    if (plugins && plugins.length > 0) {
      for (const p of plugins) this.pluginHost.use(p);
    }
    const core = this.buildCoreServices(repositories, seedGetter);
    this.mintService = core.mintService;
    this.walletService = core.walletService;
    this.walletRestoreService = core.walletRestoreService;
    this.keyRingService = core.keyRingService;
    this.seedService = core.seedService;
    this.legacyMintQuoteRepository = core.legacyMintQuoteRepository;
    this.historyService = core.historyService;
    this.paymentRequestService = core.paymentRequestService;
    this.sendOperationService = core.sendOperationService;
    this.tokenService = core.tokenService;
    this.sendOperationRepository = core.sendOperationRepository;
    this.receiveOperationService = core.receiveOperationService;
    this.receiveOperationRepository = core.receiveOperationRepository;
    this.paymentRequestReceiveService = core.paymentRequestReceiveService;
    this.paymentRequestReceiveOperationRepository = core.paymentRequestReceiveOperationRepository;
    this.paymentRequestReceiveAttemptRepository = core.paymentRequestReceiveAttemptRepository;
    this.meltOperationService = core.meltOperationService;
    this.meltOperationRepository = core.meltOperationRepository;
    this.quoteLifecycle = core.quoteLifecycle;
    this.authSessionService = core.authSessionService;
    this.authService = core.authService;
    this.mintOperationService = core.mintOperationService;
    this.mintSwapOperationService = core.mintSwapOperationService;
    this.batchMintOperationService = core.batchMintOperationService;
    this.batchMintQuoteClaims = core.batchMintQuoteClaims;
    this.mintOperationRepository = core.mintOperationRepository;
    this.proofRepository = repositories.proofRepository;
    this.balanceQueries = core.balanceQueries;
    this.transactionRunner = core.transactionRunner;
    this.subscriptions = this.createSubscriptionManager(webSocketFactory, subscriptions);
    if (!watchers?.mintOperationWatcher?.disabled) {
      this.mintOperationWatcher = new MintOperationWatcherService(
        this.subscriptions,
        this.mintService,
        this.mintOperationService,
        this.quoteLifecycle,
        this.eventBus,
        this.getChildLogger('MintOperationWatcherService'),
        {
          watchExistingPendingOnStart:
            watchers?.mintOperationWatcher?.watchExistingPendingOnStart ?? true,
          watchExistingPendingQuotesOnStart:
            watchers?.mintOperationWatcher?.watchExistingPendingQuotesOnStart ?? true,
        },
      );
    }
    if (!watchers?.proofStateWatcher?.disabled) {
      this.proofStateWatcher = new ProofStateWatcherService(
        this.subscriptions,
        this.mintService,
        this.sendOperationService,
        {
          checkProofStates: async (mintUrl, unit, proofs) => {
            const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl, unit);
            return wallet.checkProofsStates(proofs);
          },
        },
        this.eventBus,
        this.getChildLogger('ProofStateWatcherService'),
        {
          watchExistingInflightOnStart:
            watchers?.proofStateWatcher?.watchExistingInflightOnStart ?? true,
        },
      );
    }
    if (!watchers?.meltQuoteWatcher?.disabled) {
      this.meltQuoteWatcher = new MeltQuoteWatcherService(
        this.subscriptions,
        this.mintService,
        this.quoteLifecycle,
        this.eventBus,
        this.getChildLogger('MeltQuoteWatcherService'),
        {
          watchExistingPendingQuotesOnStart:
            watchers?.meltQuoteWatcher?.watchExistingPendingQuotesOnStart ?? true,
        },
      );
    }
    if (!processors?.mintOperationProcessor?.disabled) {
      this.mintOperationProcessor = new MintOperationProcessor(
        this.mintOperationService,
        this.quoteLifecycle,
        this.mintService,
        this.eventBus,
        this.getChildLogger('MintOperationProcessor'),
        processors?.mintOperationProcessor,
        this.batchMintQuoteClaims,
      );
    }
    if (!processors?.meltSettlementProcessor?.disabled) {
      this.meltSettlementProcessor = new MeltSettlementProcessor(
        this.meltOperationService,
        this.eventBus,
        this.getChildLogger('MeltSettlementProcessor'),
        {
          initializeExistingPendingOperationsOnStart:
            processors?.meltSettlementProcessor?.initializeExistingPendingOperationsOnStart ?? true,
          interestRegistrar: this.meltQuoteWatcher,
        },
      );
    }
    if (!processors?.mintSwapOperationProcessor?.disabled) {
      this.mintSwapOperationProcessor = new MintSwapOperationProcessor(
        this.mintSwapOperationService,
        this.mintSwapOperationRepository,
        this.eventBus,
        this.getChildLogger('MintSwapOperationProcessor'),
        processors?.mintSwapOperationProcessor,
        {
          mint: this.mintOperationWatcher,
          melt: this.meltQuoteWatcher,
          source: this.meltOperationRepository,
          destination: this.mintOperationRepository,
        },
      );
    }
    const apis = this.buildApis();
    this.mint = apis.mint;
    this.wallet = apis.wallet;
    this.keyring = apis.keyring;
    this.history = apis.history;
    this.ops = apis.ops;
    this.quotes = apis.quotes;
    this.auth = apis.auth;
    this.paymentRequests = apis.paymentRequests;

    // Point ext to pluginHost's extensions storage
    this.ext = this.pluginHost.getExtensions() as PluginExtensions;

    // Close subscriptions for untrusted mints
    this.eventBus.on('mint:untrusted', ({ mintUrl }) => {
      this.logger.info('Mint untrusted, closing subscriptions', { mintUrl });
      this.subscriptions.closeMint(mintUrl);
    });

    // Invalidate wallet cache when auth state changes so next getWallet() picks up the new authProvider
    const clearWalletCache = ({ mintUrl }: { mintUrl: string }) => {
      this.walletService.clearCache(mintUrl);
    };
    this.eventBus.on('auth-session:updated', clearWalletCache);
    this.eventBus.on('auth-session:deleted', clearWalletCache);
  }

  on<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): () => void {
    return this.eventBus.on(event, handler);
  }

  once<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): () => void {
    return this.eventBus.once(event, handler);
  }

  use(plugin: Plugin): void {
    this.pluginHost.use(plugin);
  }

  /**
   * Initialize the plugin system.
   * This is called automatically by `initializeCoco()`.
   * Only call this directly if you instantiate Manager without using the factory.
   */
  async initPlugins(): Promise<void> {
    const services: ServiceMap = {
      mintService: this.mintService,
      walletService: this.walletService,
      keyRingService: this.keyRingService,
      seedService: this.seedService,
      walletRestoreService: this.walletRestoreService,
      paymentRequestService: this.paymentRequestService,
      meltOperationService: this.meltOperationService,
      mintOperationService: this.mintOperationService,
      quotes: this.quotes,
      balances: this.wallet.balances,
      historyService: this.historyService,
      sendOperationService: this.sendOperationService,
      receiveOperationService: this.receiveOperationService,
      paymentRequestReceiveService: this.paymentRequestReceiveService,
      tokenService: this.tokenService,
      subscriptions: this.subscriptions,
      eventBus: this.eventBus,
      logger: this.logger,
    };
    await this.pluginHost.init(services);
    await this.pluginHost.ready();
  }

  /**
   * End this Session and release its resources. The proof watcher may finish already-started
   * processing afterward (ADR-0014); keep storage available for that work. Other owners retain
   * their drain guarantees. This is not a barrier for every explicit operation.
   */
  async dispose(): Promise<void> {
    if (this.disposePromise) {
      await this.disposePromise;
      return;
    }
    if (this.disposed) return;

    this.disposePromise = this.disposeOwnedResources();
    await this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    this.disposed = true;
    this.mintSwapDisposal.abort(new Error('Mint Swap runtime is disposed'));
    await Promise.all([
      this.mintSwapOperationProcessor?.stop(),
      this.mintSwapOperationService.dispose(),
      // Finish any admitted local transport repair before final transport closure.
      this.subscriptionRepair?.catch(() => {}),
    ]);

    await this.mintOperationWatcher?.stop();
    await this.proofStateWatcher?.stop();
    await this.meltSettlementProcessor?.stop();
    await this.meltQuoteWatcher?.stop();
    await this.mintOperationProcessor?.stop();
    await this.pluginHost.dispose();
    this.subscriptions.closeAll();
  }

  off<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): void {
    return this.eventBus.off(event, handler);
  }

  /** Internal initializer wiring for the session's fixed owners (ADR-0017). */
  async [initializeSession](): Promise<void> {
    // Initialize plugin system (must complete before watchers for extensions to be available)
    await this.initPlugins();

    // Reconcile legacy mint quote rows into mint operations before any watcher,
    // processor, or mint recovery path starts.
    await this.reconcileLegacyMintQuotes();

    // Activate the selected owners once, in the established startup order.
    await this.mintOperationWatcher?.start();
    await this.proofStateWatcher?.start();
    await this.meltQuoteWatcher?.start();
    await this.mintOperationProcessor?.start();
    await this.meltSettlementProcessor?.start();

    // Startup recovery is independent of watcher and ordinary processor selection.
    await this.ops.send.recovery.run();
    await this.ops.melt.recovery.run();
    await this.recoverPendingPaymentRequestReceiveAttempts();
    await this.recoverPendingMintOperations();
    await this.mintSwapOperationProcessor?.start();
  }

  async waitForMintOperationProcessor(): Promise<void> {
    await this.mintOperationProcessor?.waitForCompletion();
  }

  /** Recover Mint Operations, then in-flight Batch Mint Operations. */
  async recoverPendingMintOperations(): Promise<void> {
    await this.mintOperationService.recoverPendingOperations();
    await this.batchMintOperationService.recoverInFlight();
  }

  async recoverPendingPaymentRequestReceiveAttempts(): Promise<void> {
    await this.paymentRequestReceiveService.recoverPendingAttempts();
  }

  async reconcileLegacyMintQuotes(
    mintUrl?: string,
  ): Promise<{ reconciled: string[]; skipped: string[] }> {
    const reconciled: string[] = [];
    const skipped: string[] = [];
    const quotes = await this.legacyMintQuoteRepository.getPendingLegacyMintQuotes(mintUrl);

    for (const quote of quotes) {
      if (!isStatefulMintQuote(quote)) {
        skipped.push(quote.quote);
        continue;
      }

      if (assessMintQuoteClaimability(quote).status === 'complete') {
        skipped.push(quote.quote);
        continue;
      }

      const trusted = await this.mintService.isTrustedMint(quote.mintUrl);
      if (!trusted) {
        this.logger.debug('Skipping legacy mint quote reconciliation for untrusted mint', {
          mintUrl: quote.mintUrl,
          quoteId: quote.quote,
        });
        skipped.push(quote.quote);
        continue;
      }

      const existing = await this.mintOperationService.getOperationByQuote(
        quote.mintUrl,
        quote.method,
        quote.quoteId,
      );
      if (existing && existing.state !== 'init') {
        skipped.push(quote.quote);
        continue;
      }

      try {
        const imported = await this.quoteLifecycle.importMintQuote(
          quote.mintUrl,
          'bolt11',
          mintQuoteToMethodSnapshot(quote) as MintMethodQuoteSnapshot<'bolt11'>,
        );
        const amount = getMintQuoteAmount(imported);
        if (!amount) {
          throw new Error(`Legacy mint quote ${imported.quoteId} does not have a fixed amount`);
        }

        const operation = await this.mintOperationService.prepare(imported, amount);
        reconciled.push(operation.quoteId);
      } catch (err) {
        this.logger.warn('Failed to reconcile legacy mint quote', {
          mintUrl: quote.mintUrl,
          quoteId: quote.quote,
          err,
        });
        skipped.push(quote.quote);
      }
    }

    this.logger.info('Legacy mint quote reconciliation completed', {
      mintUrl,
      reconciled: reconciled.length,
      skipped: skipped.length,
    });

    return { reconciled, skipped };
  }

  /**
   * Repair networking after returning to the foreground, even if sockets appear alive.
   * Preserves current registrations and the fixed watcher and processor selection.
   * Resolves after local repair is initiated; does not wait for remote connectivity,
   * observation catch-up, or operation completion. Safe offline. Overlapping calls coalesce.
   * Does not run startup discovery or operation recovery. No-op once disposal starts.
   */
  ensureSubscriptions(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.subscriptionRepair) return this.subscriptionRepair;
    const repair = Promise.resolve().then(async () => {
      if (!this.disposed) await this.subscriptions.ensureSubscriptions();
    });
    this.subscriptionRepair = repair.finally(() => {
      this.subscriptionRepair = undefined;
    });
    return this.subscriptionRepair;
  }

  private getChildLogger(moduleName: string): Logger {
    return this.logger.child ? this.logger.child({ module: moduleName }) : this.logger;
  }

  async requeuePaidMintQuotes(mintUrl?: string): Promise<{ requeued: string[] }> {
    const requeued: string[] = [];
    const pendingOperations = await this.mintOperationService.getPendingOperations();

    for (const operation of pendingOperations) {
      if (mintUrl && operation.mintUrl !== mintUrl) continue;

      const assessment = await this.mintOperationService.getMintQuoteClaimability(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
        {
          requestedAmount: operation.amount,
          targetOperationId: operation.id,
        },
      );
      if (!assessment || (assessment.status !== 'claimable' && assessment.status !== 'complete')) {
        continue;
      }

      const trusted = await this.mintService.isTrustedMint(operation.mintUrl);
      if (!trusted) {
        continue;
      }

      await this.eventBus.emit('mint-op:requeue', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });
      requeued.push(operation.quoteId);
    }

    return { requeued };
  }

  private createEventBus(): EventBus<CoreEvents> {
    const eventLogger = this.getChildLogger('EventBus');
    return new EventBus<CoreEvents>({
      onError: (args) => {
        // Keep listener-failure diagnostics bounded.
        eventLogger.error('Event handler failed', { event: args.event });
      },
    });
  }

  private createSubscriptionManager(
    webSocketFactory?: WebSocketFactory,
    subscriptionOptions?: CocoConfig['subscriptions'],
  ): SubscriptionManager {
    const wsLogger = this.getChildLogger('SubscriptionManager');
    // Detect global WebSocket if available, otherwise require injected factory
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasGlobalWs = typeof (globalThis as any).WebSocket !== 'undefined';
    const defaultFactory: WebSocketFactory | undefined = hasGlobalWs
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (url: string) => new (globalThis as any).WebSocket(url)
      : undefined;
    const wsFactoryToUse = webSocketFactory ?? defaultFactory;
    const options = {
      slowPollingIntervalMs: subscriptionOptions?.slowPollingIntervalMs ?? 20000,
      fastPollingIntervalMs: subscriptionOptions?.fastPollingIntervalMs ?? 5000,
    };
    if (!wsFactoryToUse) {
      // Fallback to polling transport when WS is unavailable
      const polling = new PollingTransport(
        this.mintAdapter,
        { intervalMs: options.fastPollingIntervalMs },
        wsLogger,
        this.quoteLifecycle,
      );
      return new SubscriptionManager(polling, this.mintAdapter, wsLogger, options);
    }
    return new SubscriptionManager(
      wsFactoryToUse,
      this.mintAdapter,
      wsLogger,
      options,
      this.quoteLifecycle,
    );
  }

  private buildCoreServices(
    repositories: Repositories,
    seedGetter: () => Promise<Uint8Array>,
  ): {
    mintService: MintService;
    seedService: SeedService;
    walletService: WalletService;
    tokenService: TokenService;
    walletRestoreService: WalletRestoreService;
    keyRingService: KeyRingService;
    legacyMintQuoteRepository: LegacyMintQuoteRepository;
    quoteLifecycle: QuoteLifecycle;
    historyService: HistoryService;
    paymentRequestService: PaymentRequestService;
    sendOperationService: SendOperationService;
    sendOperationRepository: SendOperationRepository;
    receiveOperationService: ReceiveOperationService;
    receiveOperationRepository: ReceiveOperationRepository;
    paymentRequestReceiveService: PaymentRequestReceiveService;
    paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
    paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
    meltOperationService: MeltOperationService;
    meltOperationRepository: MeltOperationRepository;
    authSessionService: AuthSessionService;
    authService: AuthService;
    mintOperationService: MintOperationService;
    mintSwapOperationService: MintSwapOperationService;
    batchMintOperationService: BatchMintOperationService;
    batchMintQuoteClaims: BatchMintQuoteClaims;
    mintOperationRepository: MintOperationRepository;
    balanceQueries: BalanceQueries;
    transactionRunner: CoreTransactionRunner;
  } {
    const mintLogger = this.getChildLogger('MintService');
    const walletLogger = this.getChildLogger('WalletService');
    const walletRestoreLogger = this.getChildLogger('WalletRestoreService');
    const keyRingLogger = this.getChildLogger('KeyRingService');
    const historyLogger = this.getChildLogger('HistoryService');
    const tokenLogger = this.getChildLogger('TokenService');
    const seedService = new SeedService(seedGetter);
    const transactionRunner = new RepositoryCoreTransactionRunner(
      repositories,
      this.outputDataCreator,
    );
    const mintQueries = new StoredMintQueries(
      repositories.mintRepository,
      repositories.keysetRepository,
    );
    const mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      this.mintAdapter,
      {
        queries: mintQueries,
        transactionRunner,
      },
      mintLogger,
      this.eventBus,
    );
    const keypairDerivation = new KeypairDerivation(() => seedService.getSeed());
    const p2pkSigner = new KeypairP2pkSigner(repositories.keyRingRepository);
    const keyRingService = new KeyRingService(
      repositories.keyRingRepository,
      transactionRunner,
      keypairDerivation,
      p2pkSigner,
      keyRingLogger,
    );
    const walletService = new WalletService(
      mintService,
      seedService,
      this.mintRequestProvider,
      walletLogger,
      (mintUrl: string) => this.mintAdapter.getAuthProvider(mintUrl),
      this.outputDataCreator,
    );
    const balanceQueries = new StoredBalanceQueries(
      repositories.proofRepository,
      repositories.mintRepository,
    );

    // One shared instance across every counter-consuming operation service so that
    // send, receive, melt, and mint serialize their per-mint deterministic-output
    // derivation against each other. Passing separate instances would break that.
    const mintScopedLock = new MintScopedLock();
    const sourceOperationLock = new OperationIdLock();
    const destinationOperationLock = new OperationIdLock();

    const sendOperationLogger = this.getChildLogger('SendOperationService');
    const sendHandlerProvider = new SendHandlerProvider({
      default: new DefaultSendHandler(),
      p2pk: new P2pkSendHandler(),
    });
    const sendOperationService = new SendOperationService({
      operationQueries: repositories.sendOperationRepository,
      proofQueries: repositories.proofRepository,
      transactionRunner,
      mintQueries: repositories.mintRepository,
      mintMetadataRefresh: mintService,
      remote: new CashuSendRemote(
        this.mintAdapter,
        this.mintRequestProvider,
        this.outputDataCreator,
      ),
      loadSeed: () => seedService.getSeed(),
      eventBus: this.eventBus,
      handlerProvider: sendHandlerProvider,
      outputDataCreator: this.outputDataCreator,
      logger: sendOperationLogger,
      mintScopedLock,
    });
    const sendOperationRepository = repositories.sendOperationRepository;

    const tokenService = new TokenService(mintService, tokenLogger);

    const receiveOperationLogger = this.getChildLogger('ReceiveOperationService');
    const receiveOperationService = new ReceiveOperationService({
      operations: repositories.receiveOperationRepository,
      transactionRunner,
      mintQueries: repositories.mintRepository,
      mintMetadataRefresh: mintService,
      signer: p2pkSigner,
      loadSeed: () => seedService.getSeed(),
      remote: new CashuReceiveRemote(this.mintAdapter, this.mintRequestProvider),
      eventBus: this.eventBus,
      logger: receiveOperationLogger,
      mintScopedLock,
    });
    const walletRestoreService = new WalletRestoreService(
      receiveOperationService,
      transactionRunner,
      this.mintRequestProvider,
      walletRestoreLogger,
      this.outputDataCreator,
      this.eventBus,
    );
    const receiveOperationRepository = repositories.receiveOperationRepository;
    const paymentRequestReceiveOperationRepository =
      repositories.paymentRequestReceiveOperationRepository;
    const paymentRequestReceiveAttemptRepository =
      repositories.paymentRequestReceiveAttemptRepository;

    const meltOperationLogger = this.getChildLogger('MeltOperationService');
    const quoteLifecycleLogger = this.getChildLogger('QuoteLifecycle');
    const meltHandlerProvider = new MeltHandlerProvider({
      bolt11: new MeltBolt11Handler(),
      bolt12: new MeltBolt12Handler(),
      onchain: new MeltOnchainHandler(),
    });
    const mintHandlerProvider = new MintHandlerProvider({
      bolt11: new MintBolt11Handler(keyRingService),
      onchain: new MintOnchainHandler(keyRingService),
      bolt12: new MintBolt12Handler(keyRingService),
    });
    const quoteLifecycle = new QuoteLifecycle({
      // QuoteLifecycle's polling trust check defers to the session's Mint Operation Watcher,
      // when one was selected at initialization.
      hasMintRecoveryInterest: (method, identity) =>
        this.mintOperationWatcher?.hasRecoveryInterest({ ...identity, method }) ?? false,
      mintHandlerProvider,
      meltHandlerProvider,
      mintQuoteRepository: repositories.mintQuoteRepository,
      meltQuoteRepository: repositories.meltQuoteRepository,
      proofRepository: repositories.proofRepository,
      mintService,
      walletService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: quoteLifecycleLogger,
      withMintQuoteTransaction: (fn) =>
        repositories.withTransaction(({ mintQuoteRepository }) => fn(mintQuoteRepository)),
    });
    const meltOperationService = new MeltOperationService({
      handlerProvider: meltHandlerProvider,
      meltOperationQueries: repositories.meltOperationRepository,
      proofQueries: repositories.proofRepository,
      transactionRunner,
      loadSeed: () => seedService.getSeed(),
      quoteLifecycle,
      mintService,
      walletService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: meltOperationLogger,
      mintScopedLock,
      operationIdLock: sourceOperationLock,
    });
    const meltOperationRepository = repositories.meltOperationRepository;

    const batchMintOperationService = new BatchMintOperationService({
      transactionRunner,
      batchMintQueries: repositories.batchMint.operationRepository,
      proofQueries: repositories.proofRepository,
      quoteLifecycle,
      mintService,
      walletService,
      keyRingService,
      loadSeed: () => seedService.getSeed(),
      eventBus: this.eventBus,
      logger: this.getChildLogger('BatchMintOperationService'),
      mintScopedLock,
    });

    const mintOperationLogger = this.getChildLogger('MintOperationService');
    const mintOperationService = new MintOperationService({
      handlerProvider: mintHandlerProvider,
      mintOperationQueries: repositories.mintOperationRepository,
      proofQueries: repositories.proofRepository,
      transactionRunner,
      loadSeed: () => seedService.getSeed(),
      quoteLifecycle,
      mintService,
      walletService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: mintOperationLogger,
      mintScopedLock,
      operationIdLock: destinationOperationLock,
    });
    const batchMintQuoteClaims = new BatchMintQuoteClaims({
      mintOperations: mintOperationService,
      batchMintOperations: batchMintOperationService,
      quoteLifecycle,
      mintService,
      transactionRunner,
      logger: this.getChildLogger('BatchMintQuoteClaims'),
    });
    const mintOperationRepository = repositories.mintOperationRepository;
    const mintSwapOperationService = new MintSwapOperationService({
      transactionRunner,
      parentQueries: this.mintSwapOperationRepository,
      sourceQueries: repositories.meltOperationRepository,
      destinationQueries: repositories.mintOperationRepository,
      proofQueries: repositories.proofRepository,
      mintService,
      walletService,
      keyRingService,
      quoteLifecycle,
      mintHandlerProvider,
      meltHandlerProvider,
      mintAdapter: this.mintAdapter,
      loadSeed: () => seedService.getSeed(),
      sourceOperationLock,
      destinationOperationLock,
      mintScopedLock,
      eventBus: this.eventBus,
      logger: this.getChildLogger('MintSwapOperationService'),
    });

    const historyService = new HistoryService(
      repositories.historyRepository,
      this.eventBus,
      historyLogger,
    );

    const legacyMintQuoteRepository = repositories.legacyMintQuoteRepository;

    const paymentRequestLogger = this.getChildLogger('PaymentRequestService');
    const paymentRequestService = new PaymentRequestService(
      sendOperationService,
      balanceQueries,
      mintService,
      paymentRequestLogger,
    );
    const paymentRequestReceiveLogger = this.getChildLogger('PaymentRequestReceiveService');
    const paymentRequestReceiveTransportHandlerProvider =
      new PaymentRequestReceiveTransportHandlerProvider();
    const paymentRequestReceiveService = new PaymentRequestReceiveService(
      paymentRequestReceiveOperationRepository,
      paymentRequestReceiveAttemptRepository,
      receiveOperationService,
      receiveOperationRepository,
      mintService,
      paymentRequestReceiveTransportHandlerProvider,
      paymentRequestReceiveLogger,
    );

    const authSessionLogger = this.getChildLogger('AuthSessionService');
    const authSessionService = new AuthSessionService(
      repositories.authSessionRepository,
      this.eventBus,
      authSessionLogger,
    );

    const authServiceLogger = this.getChildLogger('AuthService');
    const authService = new AuthService(authSessionService, this.mintAdapter, authServiceLogger);

    return {
      mintService,
      seedService,
      walletService,
      tokenService,
      walletRestoreService,
      keyRingService,
      legacyMintQuoteRepository,
      quoteLifecycle,
      historyService,
      paymentRequestService,
      sendOperationService,
      sendOperationRepository,
      receiveOperationService,
      receiveOperationRepository,
      paymentRequestReceiveService,
      paymentRequestReceiveOperationRepository,
      paymentRequestReceiveAttemptRepository,
      meltOperationService,
      meltOperationRepository,
      authSessionService,
      authService,
      mintOperationService,
      mintSwapOperationService,
      batchMintOperationService,
      batchMintQuoteClaims,
      mintOperationRepository,
      balanceQueries,
      transactionRunner,
    };
  }

  private buildApis(): {
    mint: MintApi;
    wallet: WalletApi;
    keyring: KeyRingApi;
    history: HistoryApi;
    ops: OpsApi;
    quotes: QuoteApi;
    auth: AuthApi;
    paymentRequests: PaymentRequestsApi;
  } {
    const walletApiLogger = this.getChildLogger('WalletApi');
    const mint = new MintApi(this.mintService);
    const wallet = new WalletApi(
      this.mintService,
      this.walletService,
      this.walletRestoreService,
      this.receiveOperationService,
      this.tokenService,
      this.balanceQueries,
      walletApiLogger,
    );
    const keyring = new KeyRingApi(this.keyRingService);
    const history = new HistoryApi(this.historyService);
    const send = new SendOpsApi(this.sendOperationService);
    const receive = new ReceiveOpsApi(this.receiveOperationService);
    const mintOps = new MintOpsApi(
      this.mintOperationService,
      new BatchMintOpsApi(this.batchMintOperationService),
    );
    const melt = new MeltOpsApi(this.meltOperationService);
    const mintSwap = new MintSwapOpsApi(
      this.mintSwapOperationService,
      this.eventBus,
      this.mintSwapDisposal.signal,
    );
    const ops = new OpsApi(send, receive, mintOps, melt, mintSwap);
    const quotes = new QuoteApi(this.quoteLifecycle);
    const auth = new AuthApi(this.authService);
    const paymentRequests = new PaymentRequestsApi(
      this.paymentRequestService,
      this.paymentRequestReceiveService,
    );
    return {
      mint,
      wallet,
      keyring,
      history,
      ops,
      quotes,
      auth,
      paymentRequests,
    };
  }
}
