import type { Repositories } from './repositories';
import {
  CounterService,
  MintService,
  MintQuoteService,
  ProofService,
  WalletService,
  SeedService,
} from './services';
import { EventBus, type CoreEvents } from './events';
import { type Logger, NullLogger } from './logging';
import { MintApi, WalletApi, QuotesApi } from './api';

export class Manager {
  readonly mint: MintApi;
  readonly wallet: WalletApi;
  readonly quotes: QuotesApi;
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private proofService: ProofService;
  private seedService: SeedService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;

  constructor(repositories: Repositories, seedGetter: () => Promise<Uint8Array>, logger?: Logger) {
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
      proofLogger,
      this.eventBus,
    );
    const quotesService = new MintQuoteService(
      repositories.mintQuoteRepository,
      this.walletService,
      this.proofService,
      this.eventBus,
      mintQuoteLogger,
    );
    this.mint = new MintApi(this.mintService);
    this.wallet = new WalletApi(this.mintService, this.walletService, this.proofService);
    this.quotes = new QuotesApi(quotesService);
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
}
