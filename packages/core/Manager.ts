import type { OutputDataCreator } from '@cashu/cashu-ts';

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
  CounterService,
  MintService,
  MintOperationWatcherService,
  MintOperationProcessor,
  MeltQuoteWatcherService,
  MeltSettlementProcessor,
  ProofService,
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
import { ReceiveOperationService } from './operations/receive/ReceiveOperationService';
import { MintScopedLock } from './operations/MintScopedLock';
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
   * Watcher configuration (all enabled by default)
   * - Omit to use defaults (enabled)
   * - Set `disabled: true` to disable
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
      /** When enabled, scan existing inflight proofs on start (default: true) */
      watchExistingInflightOnStart?: boolean;
    };
    /** Melt quote watcher (enabled by default) */
    meltQuoteWatcher?: {
      disabled?: boolean;
      watchExistingPendingQuotesOnStart?: boolean;
    };
  };
  /**
   * Processor configuration (all enabled by default)
   * - Omit to use defaults (enabled)
   * - Set `disabled: true` to disable
   * - Provide options to customize behavior
   */
  processors?: {
    /** Mint operation processor (enabled by default) */
    mintOperationProcessor?: {
      disabled?: boolean;
      processIntervalMs?: number;
      maxRetries?: number;
      baseRetryDelayMs?: number;
      initialEnqueueDelayMs?: number;
      autoClaimMintQuotes?: boolean;
    };
    /** Melt settlement processor (enabled by default) */
    meltSettlementProcessor?: {
      disabled?: boolean;
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
}

/**
 * Initializes and configures a new Coco Cashu manager instance
 * @param config - Configuration options including repositories, seed, and optional features
 * @returns A fully initialized Manager instance
 */
export async function initializeCoco(config: CocoConfig): Promise<Manager> {
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
  );

  // Initialize plugin system (must complete before watchers for extensions to be available)
  await coco.initPlugins();

  // Reconcile legacy mint quote rows into mint operations before any watcher,
  // processor, or mint recovery path starts.
  await coco.reconcileLegacyMintQuotes();

  // Enable watchers (default: all enabled unless explicitly disabled)
  const mintOperationWatcherConfig = config.watchers?.mintOperationWatcher;
  if (!mintOperationWatcherConfig?.disabled) {
    await coco.enableMintOperationWatcher(mintOperationWatcherConfig);
  }

  const proofStateWatcherConfig = config.watchers?.proofStateWatcher;
  if (!proofStateWatcherConfig?.disabled) {
    await coco.enableProofStateWatcher(proofStateWatcherConfig);
  }

  const meltQuoteWatcherConfig = config.watchers?.meltQuoteWatcher;
  if (!meltQuoteWatcherConfig?.disabled) {
    await coco.enableMeltQuoteWatcher(meltQuoteWatcherConfig);
  }

  // Enable processors (default: all enabled unless explicitly disabled)
  const mintOperationProcessorConfig = config.processors?.mintOperationProcessor;
  if (!mintOperationProcessorConfig?.disabled) {
    await coco.enableMintOperationProcessor(mintOperationProcessorConfig);
  }

  const meltSettlementProcessorConfig = config.processors?.meltSettlementProcessor;
  if (!meltSettlementProcessorConfig?.disabled) {
    await coco.enableMeltSettlementProcessor(meltSettlementProcessorConfig);
  }

  // Recover any pending send operations from previous session
  await coco.ops.send.recovery.run();

  // Recover any pending melt operations from previous session
  await coco.ops.melt.recovery.run();

  // Recover any pending receive operations and payment-request receive attempts from previous session
  await coco.recoverPendingPaymentRequestReceiveAttempts();

  // Recover any pending mint operations from previous session
  await coco.recoverPendingMintOperations();

  return coco;
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
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private keyRingService: KeyRingService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;
  readonly subscriptions: SubscriptionManager;
  private mintOperationWatcher?: MintOperationWatcherService;
  private mintOperationProcessor?: MintOperationProcessor;
  private meltQuoteWatcher?: MeltQuoteWatcherService;
  private meltSettlementProcessor?: MeltSettlementProcessor;
  private legacyMintQuoteRepository: LegacyMintQuoteRepository;
  private quoteLifecycle: QuoteLifecycle;
  private proofStateWatcher?: ProofStateWatcherService;
  private historyService: HistoryService;
  private seedService: SeedService;
  private counterService: CounterService;
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
  private mintOperationRepository: MintOperationRepository;
  private receiveOperationService: ReceiveOperationService;
  private receiveOperationRepository: ReceiveOperationRepository;
  private paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  private paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  private proofRepository: Repositories['proofRepository'];
  private readonly pluginHost: PluginHost = new PluginHost();
  private subscriptionsPaused = false;
  private originalWatcherConfig: CocoConfig['watchers'];
  private originalProcessorConfig: CocoConfig['processors'];
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
  ) {
    this.logger = logger ?? new NullLogger();
    this.eventBus = this.createEventBus();
    this.outputDataCreator = outputDataCreator;

    // Create shared request provider and mint adapter first
    // These are shared across WalletService and SubscriptionManager (polling)
    this.mintRequestProvider = new MintRequestProvider({
      capacity: 20,
      refillPerMinute: 20,
      logger: this.getChildLogger('RequestRateLimiter'),
    });
    this.mintAdapter = new MintAdapter(this.mintRequestProvider);

    this.originalWatcherConfig = watchers;
    this.originalProcessorConfig = processors;
    if (plugins && plugins.length > 0) {
      for (const p of plugins) this.pluginHost.use(p);
    }
    const core = this.buildCoreServices(repositories, seedGetter);
    this.mintService = core.mintService;
    this.walletService = core.walletService;
    this.proofService = core.proofService;
    this.walletRestoreService = core.walletRestoreService;
    this.keyRingService = core.keyRingService;
    this.seedService = core.seedService;
    this.counterService = core.counterService;
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
    this.mintOperationRepository = core.mintOperationRepository;
    this.proofRepository = repositories.proofRepository;
    this.subscriptions = this.createSubscriptionManager(webSocketFactory, subscriptions);
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
      proofService: this.proofService,
      keyRingService: this.keyRingService,
      seedService: this.seedService,
      walletRestoreService: this.walletRestoreService,
      paymentRequestService: this.paymentRequestService,
      counterService: this.counterService,
      meltOperationService: this.meltOperationService,
      mintOperationService: this.mintOperationService,
      quotes: this.quotes,
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
    this.subscriptionsPaused = true;

    await this.disableMintOperationWatcher();
    await this.disableProofStateWatcher();
    await this.disableMeltSettlementProcessor();
    await this.disableMeltQuoteWatcher();
    await this.disableMintOperationProcessor();
    await this.pluginHost.dispose();
    this.subscriptions.closeAll();
  }

  off<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): void {
    return this.eventBus.off(event, handler);
  }

  async enableMintOperationWatcher(options?: {
    watchExistingPendingOnStart?: boolean;
    watchExistingPendingQuotesOnStart?: boolean;
  }): Promise<void> {
    if (this.disposed) return;
    if (this.mintOperationWatcher?.isRunning()) return;
    const watcherLogger = this.logger.child
      ? this.logger.child({ module: 'MintOperationWatcherService' })
      : this.logger;
    this.mintOperationWatcher = new MintOperationWatcherService(
      this.subscriptions,
      this.mintService,
      this.mintOperationService,
      this.quoteLifecycle,
      this.eventBus,
      watcherLogger,
      {
        watchExistingPendingOnStart: options?.watchExistingPendingOnStart ?? true,
        watchExistingPendingQuotesOnStart: options?.watchExistingPendingQuotesOnStart ?? true,
      },
    );
    await this.mintOperationWatcher.start();
  }

  async disableMintOperationWatcher(): Promise<void> {
    if (!this.mintOperationWatcher) return;
    await this.mintOperationWatcher.stop();
    this.mintOperationWatcher = undefined;
  }

  async enableMintOperationProcessor(options?: {
    processIntervalMs?: number;
    maxRetries?: number;
    baseRetryDelayMs?: number;
    initialEnqueueDelayMs?: number;
    autoClaimMintQuotes?: boolean;
  }): Promise<boolean> {
    if (this.disposed) return false;
    if (this.mintOperationProcessor?.isRunning()) return false;
    const processorLogger = this.logger.child
      ? this.logger.child({ module: 'MintOperationProcessor' })
      : this.logger;
    this.mintOperationProcessor = new MintOperationProcessor(
      this.mintOperationService,
      this.quoteLifecycle,
      this.eventBus,
      processorLogger,
      options,
    );
    await this.mintOperationProcessor.start();
    return true;
  }

  async disableMintOperationProcessor(): Promise<void> {
    if (!this.mintOperationProcessor) return;
    await this.mintOperationProcessor.stop();
    this.mintOperationProcessor = undefined;
  }

  async enableMeltQuoteWatcher(options?: {
    watchExistingPendingQuotesOnStart?: boolean;
  }): Promise<void> {
    if (this.disposed) return;
    if (this.meltQuoteWatcher?.isRunning()) {
      await this.meltSettlementProcessor?.setInterestRegistrar(this.meltQuoteWatcher);
      return;
    }
    const watcherLogger = this.logger.child
      ? this.logger.child({ module: 'MeltQuoteWatcherService' })
      : this.logger;
    this.meltQuoteWatcher = new MeltQuoteWatcherService(
      this.subscriptions,
      this.mintService,
      this.quoteLifecycle,
      this.eventBus,
      watcherLogger,
      {
        watchExistingPendingQuotesOnStart: options?.watchExistingPendingQuotesOnStart ?? true,
      },
    );
    await this.meltQuoteWatcher.start();
    await this.meltSettlementProcessor?.setInterestRegistrar(this.meltQuoteWatcher);
  }

  async disableMeltQuoteWatcher(): Promise<void> {
    if (!this.meltQuoteWatcher) return;
    await this.meltSettlementProcessor?.setInterestRegistrar(undefined);
    await this.meltQuoteWatcher.stop();
    this.meltQuoteWatcher = undefined;
  }

  async enableMeltSettlementProcessor(options?: {
    initializeExistingPendingOperationsOnStart?: boolean;
  }): Promise<boolean> {
    if (this.disposed) return false;
    if (this.meltSettlementProcessor?.isRunning()) return false;
    const processorLogger = this.logger.child
      ? this.logger.child({ module: 'MeltSettlementProcessor' })
      : this.logger;
    this.meltSettlementProcessor = new MeltSettlementProcessor(
      this.meltOperationService,
      this.eventBus,
      processorLogger,
      {
        initializeExistingPendingOperationsOnStart:
          options?.initializeExistingPendingOperationsOnStart ?? true,
        interestRegistrar: this.meltQuoteWatcher,
      },
    );
    await this.meltSettlementProcessor.start();
    return true;
  }

  async disableMeltSettlementProcessor(): Promise<void> {
    if (!this.meltSettlementProcessor) return;
    await this.meltSettlementProcessor.stop();
    this.meltSettlementProcessor = undefined;
  }

  async waitForMintOperationProcessor(): Promise<void> {
    if (!this.mintOperationProcessor) return;
    await this.mintOperationProcessor.waitForCompletion();
  }

  async enableProofStateWatcher(options?: {
    watchExistingInflightOnStart?: boolean;
  }): Promise<void> {
    if (this.disposed) return;
    if (this.proofStateWatcher?.isRunning()) return;
    const watcherLogger = this.logger.child
      ? this.logger.child({ module: 'ProofStateWatcherService' })
      : this.logger;
    this.proofStateWatcher = new ProofStateWatcherService(
      this.subscriptions,
      this.mintService,
      this.proofService,
      this.proofRepository,
      this.eventBus,
      watcherLogger,
      { watchExistingInflightOnStart: options?.watchExistingInflightOnStart ?? true },
    );
    this.proofStateWatcher.setSendOperationService(this.sendOperationService);
    await this.proofStateWatcher.start();
  }

  async disableProofStateWatcher(): Promise<void> {
    if (!this.proofStateWatcher) return;
    await this.proofStateWatcher.stop();
    this.proofStateWatcher = undefined;
  }

  async recoverPendingMintOperations(): Promise<void> {
    await this.mintOperationService.recoverPendingOperations();
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

      if (quote.state === 'ISSUED') {
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

  async pauseSubscriptions(): Promise<void> {
    if (this.subscriptionsPaused) {
      this.logger.debug('Subscriptions already paused');
      return;
    }
    this.subscriptionsPaused = true;
    this.logger.info('Pausing subscriptions');

    // Pause transport layer
    this.subscriptions.pause();

    // Disable watchers
    await this.disableMintOperationWatcher();
    await this.disableProofStateWatcher();
    await this.disableMeltSettlementProcessor();
    await this.disableMeltQuoteWatcher();

    // Disable processor
    await this.disableMintOperationProcessor();

    this.logger.info('Subscriptions paused');
    await this.eventBus.emit('subscriptions:paused', undefined);
  }

  async resumeSubscriptions(): Promise<void> {
    if (this.disposed) {
      this.logger.debug('Cannot resume subscriptions after manager disposal');
      return;
    }
    this.subscriptionsPaused = false;
    this.logger.info('Resuming subscriptions');
    await this.eventBus.emit('subscriptions:resumed', undefined);

    // Resume transport layer
    this.subscriptions.resume();

    // Re-enable watchers based on original configuration (idempotent)
    const mintOperationWatcherConfig = this.originalWatcherConfig?.mintOperationWatcher;
    if (!mintOperationWatcherConfig?.disabled) {
      await this.enableMintOperationWatcher(mintOperationWatcherConfig);
    }

    const proofStateWatcherConfig = this.originalWatcherConfig?.proofStateWatcher;
    if (!proofStateWatcherConfig?.disabled) {
      await this.enableProofStateWatcher(proofStateWatcherConfig);
    }

    const meltQuoteWatcherConfig = this.originalWatcherConfig?.meltQuoteWatcher;
    if (!meltQuoteWatcherConfig?.disabled) {
      await this.enableMeltQuoteWatcher(meltQuoteWatcherConfig);
    }

    // Re-enable processor based on original configuration (idempotent)
    const mintOperationProcessorConfig = this.originalProcessorConfig?.mintOperationProcessor;
    if (!mintOperationProcessorConfig?.disabled) {
      await this.enableMintOperationProcessor(mintOperationProcessorConfig);
    }

    const meltSettlementProcessorConfig = this.originalProcessorConfig?.meltSettlementProcessor;
    if (!meltSettlementProcessorConfig?.disabled) {
      await this.enableMeltSettlementProcessor(meltSettlementProcessorConfig);
    }

    await this.recoverPendingMintOperations();

    this.logger.info('Subscriptions resumed');
  }

  private getChildLogger(moduleName: string): Logger {
    return this.logger.child ? this.logger.child({ module: moduleName }) : this.logger;
  }

  async requeuePaidMintQuotes(mintUrl?: string): Promise<{ requeued: string[] }> {
    const requeued: string[] = [];
    const pendingOperations = await this.mintOperationService.getPendingOperations();

    for (const operation of pendingOperations) {
      if (mintUrl && operation.mintUrl !== mintUrl) continue;

      const quote = await this.quoteLifecycle.getMintQuote(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
      if (!quote || !isStatefulMintQuote(quote) || quote.state !== 'PAID') continue;

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
        eventLogger.error('Event handler error', args);
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
    counterService: CounterService;
    proofService: ProofService;
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
    mintOperationRepository: MintOperationRepository;
  } {
    const mintLogger = this.getChildLogger('MintService');
    const walletLogger = this.getChildLogger('WalletService');
    const counterLogger = this.getChildLogger('CounterService');
    const proofLogger = this.getChildLogger('ProofService');
    const walletRestoreLogger = this.getChildLogger('WalletRestoreService');
    const keyRingLogger = this.getChildLogger('KeyRingService');
    const historyLogger = this.getChildLogger('HistoryService');
    const tokenLogger = this.getChildLogger('TokenService');
    const mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      this.mintAdapter,
      mintLogger,
      this.eventBus,
    );
    const seedService = new SeedService(seedGetter);
    const keyRingService = new KeyRingService(
      repositories.keyRingRepository,
      seedService,
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
    const counterService = new CounterService(
      repositories.counterRepository,
      counterLogger,
      this.eventBus,
    );
    const proofService = new ProofService(
      counterService,
      repositories.proofRepository,
      walletService,
      mintService,
      keyRingService,
      seedService,
      proofLogger,
      this.eventBus,
      this.outputDataCreator,
    );
    const walletRestoreService = new WalletRestoreService(
      proofService,
      counterService,
      walletService,
      this.mintRequestProvider,
      walletRestoreLogger,
      this.outputDataCreator,
    );

    // One shared instance across every counter-consuming operation service so that
    // send, receive, melt, and mint serialize their per-mint deterministic-output
    // derivation against each other. Passing separate instances would break that.
    const mintScopedLock = new MintScopedLock();

    const sendOperationLogger = this.getChildLogger('SendOperationService');
    const sendHandlerProvider = new SendHandlerProvider({
      default: new DefaultSendHandler(),
      p2pk: new P2pkSendHandler(this.outputDataCreator),
    });
    const sendOperationService = new SendOperationService(
      repositories.sendOperationRepository,
      repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      this.eventBus,
      sendHandlerProvider,
      sendOperationLogger,
      mintScopedLock,
    );
    const sendOperationRepository = repositories.sendOperationRepository;

    const tokenService = new TokenService(mintService, tokenLogger);

    const receiveOperationLogger = this.getChildLogger('ReceiveOperationService');
    const receiveOperationService = new ReceiveOperationService(
      repositories.receiveOperationRepository,
      repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      this.mintAdapter,
      tokenService,
      this.eventBus,
      receiveOperationLogger,
      mintScopedLock,
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
      bolt11: new MintBolt11Handler(),
      onchain: new MintOnchainHandler(keyRingService),
      bolt12: new MintBolt12Handler(keyRingService),
    });
    const quoteLifecycle = new QuoteLifecycle({
      mintHandlerProvider,
      meltHandlerProvider,
      mintQuoteRepository: repositories.mintQuoteRepository,
      meltQuoteRepository: repositories.meltQuoteRepository,
      proofRepository: repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      mintAdapter: this.mintAdapter,
      eventBus: this.eventBus,
      logger: quoteLifecycleLogger,
    });
    const meltOperationService = new MeltOperationService(
      meltHandlerProvider,
      repositories.meltOperationRepository,
      quoteLifecycle,
      repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      this.mintAdapter,
      this.eventBus,
      meltOperationLogger,
      mintScopedLock,
    );
    const meltOperationRepository = repositories.meltOperationRepository;

    const mintOperationLogger = this.getChildLogger('MintOperationService');
    const mintOperationService = new MintOperationService(
      mintHandlerProvider,
      repositories.mintOperationRepository,
      quoteLifecycle,
      repositories.proofRepository,
      proofService,
      mintService,
      walletService,
      this.mintAdapter,
      this.eventBus,
      mintOperationLogger,
      mintScopedLock,
    );
    const mintOperationRepository = repositories.mintOperationRepository;

    const historyService = new HistoryService(
      repositories.historyRepository,
      this.eventBus,
      historyLogger,
    );

    const legacyMintQuoteRepository = repositories.legacyMintQuoteRepository;

    const paymentRequestLogger = this.getChildLogger('PaymentRequestService');
    const paymentRequestService = new PaymentRequestService(
      sendOperationService,
      proofService,
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
      counterService,
      proofService,
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
      mintOperationRepository,
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
      this.proofService,
      this.walletRestoreService,
      this.receiveOperationService,
      this.tokenService,
      walletApiLogger,
    );
    const keyring = new KeyRingApi(this.keyRingService);
    const history = new HistoryApi(this.historyService);
    const send = new SendOpsApi(this.sendOperationService);
    const receive = new ReceiveOpsApi(this.receiveOperationService);
    const mintOps = new MintOpsApi(this.mintOperationService);
    const melt = new MeltOpsApi(this.meltOperationService);
    const ops = new OpsApi(send, receive, mintOps, melt);
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
