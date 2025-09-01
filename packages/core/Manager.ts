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

  constructor(
    repositories: Repositories,
    seedGetter: () => Promise<Uint8Array>,
    logger?: Logger,
    webSocketFactory?: WebSocketFactory,
  ) {
    this.logger = logger ?? new NullLogger();
    const eventLogger = this.logger.child ? this.logger.child({ module: 'EventBus' }) : this.logger;

    this.eventBus = new EventBus<CoreEvents>({
      onError: (args) => {
        eventLogger.error('Event handler error', args);
      },
    });

    const mintLogger = this.logger.child
      ? this.logger.child({ module: 'MintService' })
      : this.logger;
    const walletLogger = this.logger.child
      ? this.logger.child({ module: 'WalletService' })
      : this.logger;
    const counterLogger = this.logger.child
      ? this.logger.child({ module: 'CounterService' })
      : this.logger;
    const proofLogger = this.logger.child
      ? this.logger.child({ module: 'ProofService' })
      : this.logger;
    const mintQuoteLogger = this.logger.child
      ? this.logger.child({ module: 'MintQuoteService' })
      : this.logger;
    const walletRestoreLogger = this.logger.child
      ? this.logger.child({ module: 'WalletRestoreService' })
      : this.logger;
    const walletApiLogger = this.logger.child
      ? this.logger.child({ module: 'WalletApi' })
      : this.logger;

    this.mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      mintLogger,
      this.eventBus,
    );
    this.seedService = new SeedService(seedGetter);
    this.walletService = new WalletService(this.mintService, this.seedService, walletLogger);
    this.counterService = new CounterService(
      repositories.counterRepository,
      counterLogger,
      this.eventBus,
    );
    this.proofService = new ProofService(
      this.counterService,
      repositories.proofRepository,
      this.walletService,
      this.seedService,
      proofLogger,
      this.eventBus,
    );
    this.walletRestoreService = new WalletRestoreService(
      this.proofService,
      this.counterService,
      walletRestoreLogger,
    );

    const wsLogger = this.logger.child
      ? this.logger.child({ module: 'SubscriptionManager' })
      : this.logger;
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
      this.subscriptions = new SubscriptionManager(throwingFactory, wsLogger);
    } else {
      this.subscriptions = new SubscriptionManager(wsFactoryToUse, wsLogger);
    }

    const quotesService = new MintQuoteService(
      repositories.mintQuoteRepository,
      this.subscriptions,
      this.walletService,
      this.proofService,
      this.eventBus,
      mintQuoteLogger,
    );
    this.mintQuoteService = quotesService;
    this.mintQuoteRepository = repositories.mintQuoteRepository;
    this.mint = new MintApi(this.mintService);
    this.wallet = new WalletApi(
      this.mintService,
      this.walletService,
      this.proofService,
      this.walletRestoreService,
      walletApiLogger,
    );
    this.quotes = new QuotesApi(quotesService);

    const subscriptionApiLogger = this.logger.child
      ? this.logger.child({ module: 'SubscriptionApi' })
      : this.logger;
    this.subscription = new SubscriptionApi(this.subscriptions, subscriptionApiLogger);
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
}
