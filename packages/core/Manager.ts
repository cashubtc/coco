import type { Repositories } from './repositories';
import {
  CounterService,
  MintService,
  MintQuoteService,
  ProofService,
  WalletService,
} from './services';
import { type Mint, type Keyset } from './models';
import { EventBus, type CoreEvents } from './events';
import { type Logger, NullLogger } from './logging';
import { WalletApi, QuotesApi } from './api';

export class Manager {
  readonly wallet: WalletApi;
  readonly quotes: QuotesApi;
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private proofService: ProofService;
  private eventBus: EventBus<CoreEvents>;
  private logger: Logger;

  constructor(repositories: Repositories, logger?: Logger) {
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
    this.walletService = new WalletService(this.mintService, walletLogger);
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
    this.wallet = new WalletApi(this.mintService, this.walletService, this.proofService);
    this.quotes = new QuotesApi(quotesService);
  }

  async addMint(mintUrl: string): Promise<{
    mint: Mint;
    keysets: Keyset[];
  }> {
    return this.mintService.addMintByUrl(mintUrl);
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

  async getBalances(): Promise<{ [mintUrl: string]: number }> {
    const proofs = await this.proofService.getAllReadyProofs();
    const balances: { [mintUrl: string]: number } = {};
    for (const proof of proofs) {
      const mintUrl = proof.mintUrl;
      const balance = balances[mintUrl] || 0;
      balances[mintUrl] = balance + proof.amount;
    }
    return balances;
  }
}
