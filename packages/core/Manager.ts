import type { Repositories, MintQuoteRepository } from './repositories';
import {
  CounterService,
  MintService,
  MintQuoteService,
  MintQuoteWatcherService,
  ProofService,
  WalletService,
  SeedService,
  WalletRestoreService,
  ProofStateWatcherService,
  MeltQuoteService,
} from './services';
import { SubscriptionManager, type WebSocketFactory, PollingTransport } from './infra';
import { EventBus, type CoreEvents } from './events';
import { type Logger, NullLogger } from './logging';
import { MintApi, WalletApi, QuotesApi } from './api';
import { SubscriptionApi } from './api/SubscriptionApi.ts';

export class Manager {
  readonly mint: MintApi;
  readonly wallet: WalletApi;
  readonly quotes: QuotesApi;
  readonly subscription: SubscriptionApi;
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;
  readonly subscriptions: SubscriptionManager;
  private mintQuoteService: MintQuoteService;
  private mintQuoteWatcher?: MintQuoteWatcherService;
  private mintQuoteRepository: MintQuoteRepository;
  private proofStateWatcher?: ProofStateWatcherService;
  private meltQuoteService: MeltQuoteService;
  constructor(
    repositories: Repositories,
    seedGetter: () => Promise<Uint8Array>,
    logger?: Logger,
    webSocketFactory?: WebSocketFactory,
  ) {
    this.logger = logger ?? new NullLogger();
    this.eventBus = this.createEventBus();
    this.subscriptions = this.createSubscriptionManager(webSocketFactory);
    const core = this.buildCoreServices(repositories, seedGetter);
    this.mintService = core.mintService;
    this.walletService = core.walletService;
    this.proofService = core.proofService;
    this.walletRestoreService = core.walletRestoreService;
    this.mintQuoteService = core.mintQuoteService;
    this.mintQuoteRepository = core.mintQuoteRepository;
    this.meltQuoteService = core.meltQuoteService;
    const apis = this.buildApis();
    this.mint = apis.mint;
    this.wallet = apis.wallet;
    this.quotes = apis.quotes;
    this.subscription = apis.subscription;
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

  off<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): void {
    return this.eventBus.off(event, handler);
  }

  async enableMintQuoteWatcher(options?: { watchExistingPendingOnStart?: boolean }): Promise<void> {
    if (this.mintQuoteWatcher?.isRunning()) return;
    const watcherLogger = this.logger.child
      ? this.logger.child({ module: 'MintQuoteWatcherService' })
      : this.logger;
    this.mintQuoteWatcher = new MintQuoteWatcherService(
      this.mintQuoteRepository,
      this.subscriptions,
      this.mintQuoteService,
      this.eventBus,
      watcherLogger,
      { watchExistingPendingOnStart: options?.watchExistingPendingOnStart ?? true },
    );
    await this.mintQuoteWatcher.start();
  }

  async disableMintQuoteWatcher(): Promise<void> {
    if (!this.mintQuoteWatcher) return;
    await this.mintQuoteWatcher.stop();
    this.mintQuoteWatcher = undefined;
  }

  async enableProofStateWatcher(): Promise<void> {
    if (this.proofStateWatcher?.isRunning()) return;
    const watcherLogger = this.logger.child
      ? this.logger.child({ module: 'ProofStateWatcherService' })
      : this.logger;
    this.proofStateWatcher = new ProofStateWatcherService(
      this.subscriptions,
      this.proofService,
      this.eventBus,
      watcherLogger,
    );
    await this.proofStateWatcher.start();
  }

  async disableProofStateWatcher(): Promise<void> {
    if (!this.proofStateWatcher) return;
    await this.proofStateWatcher.stop();
    this.proofStateWatcher = undefined;
  }

  private getChildLogger(moduleName: string): Logger {
    return this.logger.child ? this.logger.child({ module: moduleName }) : this.logger;
  }

  private createEventBus(): EventBus<CoreEvents> {
    const eventLogger = this.getChildLogger('EventBus');
    return new EventBus<CoreEvents>({
      onError: (args) => {
        eventLogger.error('Event handler error', args);
      },
    });
  }

  private createSubscriptionManager(webSocketFactory?: WebSocketFactory): SubscriptionManager {
    const wsLogger = this.getChildLogger('SubscriptionManager');
    // Detect global WebSocket if available, otherwise require injected factory
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasGlobalWs = typeof (globalThis as any).WebSocket !== 'undefined';
    const defaultFactory: WebSocketFactory | undefined = hasGlobalWs
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (url: string) => new (globalThis as any).WebSocket(url)
      : undefined;
    const wsFactoryToUse = webSocketFactory ?? defaultFactory;
    const capabilitiesProvider = {
      getMintInfo: async (mintUrl: string) => {
        if (!this.mintService) throw new Error('MintService not initialized yet');
        return this.mintService.getMintInfo(mintUrl);
      },
    };
    if (!wsFactoryToUse) {
      // Fallback to polling transport when WS is unavailable
      const polling = new PollingTransport({ intervalMs: 5000 }, wsLogger);
      return new SubscriptionManager(polling, wsLogger, capabilitiesProvider);
    }
    return new SubscriptionManager(wsFactoryToUse, wsLogger, capabilitiesProvider);
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
    walletRestoreService: WalletRestoreService;
    mintQuoteService: MintQuoteService;
    mintQuoteRepository: MintQuoteRepository;
    meltQuoteService: MeltQuoteService;
  } {
    const mintLogger = this.getChildLogger('MintService');
    const walletLogger = this.getChildLogger('WalletService');
    const counterLogger = this.getChildLogger('CounterService');
    const proofLogger = this.getChildLogger('ProofService');
    const mintQuoteLogger = this.getChildLogger('MintQuoteService');
    const walletRestoreLogger = this.getChildLogger('WalletRestoreService');
    const meltQuoteLogger = this.getChildLogger('MeltQuoteService');
    const mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      mintLogger,
      this.eventBus,
    );
    const seedService = new SeedService(seedGetter);
    const walletService = new WalletService(mintService, seedService, walletLogger);
    const counterService = new CounterService(
      repositories.counterRepository,
      counterLogger,
      this.eventBus,
    );
    const proofService = new ProofService(
      counterService,
      repositories.proofRepository,
      walletService,
      seedService,
      proofLogger,
      this.eventBus,
    );
    const walletRestoreService = new WalletRestoreService(
      proofService,
      counterService,
      walletRestoreLogger,
    );

    const quotesService = new MintQuoteService(
      repositories.mintQuoteRepository,
      this.subscriptions,
      walletService,
      proofService,
      this.eventBus,
      mintQuoteLogger,
    );
    const mintQuoteService = quotesService;
    const mintQuoteRepository = repositories.mintQuoteRepository;

    const meltQuoteService = new MeltQuoteService(
      proofService,
      walletService,
      repositories.meltQuoteRepository,
      this.eventBus,
      meltQuoteLogger,
    );

    return {
      mintService,
      seedService,
      walletService,
      counterService,
      proofService,
      walletRestoreService,
      mintQuoteService,
      mintQuoteRepository,
      meltQuoteService,
    };
  }

  private buildApis(): {
    mint: MintApi;
    wallet: WalletApi;
    quotes: QuotesApi;
    subscription: SubscriptionApi;
  } {
    const walletApiLogger = this.getChildLogger('WalletApi');
    const subscriptionApiLogger = this.getChildLogger('SubscriptionApi');
    const mint = new MintApi(this.mintService);
    const wallet = new WalletApi(
      this.mintService,
      this.walletService,
      this.proofService,
      this.walletRestoreService,
      walletApiLogger,
    );
    const quotes = new QuotesApi(this.mintQuoteService, this.meltQuoteService);
    const subscription = new SubscriptionApi(this.subscriptions, subscriptionApiLogger);
    return { mint, wallet, quotes, subscription };
  }
}
