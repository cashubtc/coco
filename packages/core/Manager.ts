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
} from './services';
import { SubscriptionManager, type WebSocketFactory } from './infra';
import { EventBus, type CoreEvents } from './events';
import { type Logger, NullLogger } from './logging';
import { MintApi, WalletApi, QuotesApi, SubscriptionApi } from './api';

export class Manager {
  readonly mint: MintApi;
  readonly wallet: WalletApi;
  readonly quotes: QuotesApi;
  readonly subscription: SubscriptionApi;
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private proofService: ProofService;
  private seedService: SeedService;
  private walletRestoreService: WalletRestoreService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;
  readonly subscriptions: SubscriptionManager;
  private mintQuoteService: MintQuoteService;
  private mintQuoteWatcher?: MintQuoteWatcherService;
  private mintQuoteRepository: MintQuoteRepository;
  private proofStateWatcher?: ProofStateWatcherService;

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
    this.seedService = core.seedService;
    this.walletService = core.walletService;
    this.counterService = core.counterService;
    this.proofService = core.proofService;
    this.walletRestoreService = core.walletRestoreService;
    this.mintQuoteService = core.mintQuoteService;
    this.mintQuoteRepository = core.mintQuoteRepository;
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
    if (!wsFactoryToUse) {
      const throwingFactory: WebSocketFactory = () => {
        throw new Error('No WebSocketFactory provided and no global WebSocket available');
      };
      return new SubscriptionManager(throwingFactory, wsLogger);
    }
    return new SubscriptionManager(wsFactoryToUse, wsLogger);
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
  } {
    const mintLogger = this.getChildLogger('MintService');
    const walletLogger = this.getChildLogger('WalletService');
    const counterLogger = this.getChildLogger('CounterService');
    const proofLogger = this.getChildLogger('ProofService');
    const mintQuoteLogger = this.getChildLogger('MintQuoteService');
    const walletRestoreLogger = this.getChildLogger('WalletRestoreService');

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

    return {
      mintService,
      seedService,
      walletService,
      counterService,
      proofService,
      walletRestoreService,
      mintQuoteService,
      mintQuoteRepository,
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
    const quotes = new QuotesApi(this.mintQuoteService);
    const subscription = new SubscriptionApi(this.subscriptions, subscriptionApiLogger);
    return { mint, wallet, quotes, subscription };
  }
}
