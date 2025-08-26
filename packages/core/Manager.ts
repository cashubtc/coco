import { getDecodedToken, type MintQuoteResponse, type Token } from '@cashu/cashu-ts';
import type { Repositories } from './repositories';
import {
  CounterService,
  MintService,
  MintQuoteService,
  ProofService,
  WalletService,
} from './services';
import { type Mint, type Keyset, UnknownMintError } from './models';
import { EventBus, type CoreEvents } from './events';
import type { Logger } from './logging/Logger.ts';
import { NullLogger } from './logging/NullLogger.ts';

export class Manager {
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private proofService: ProofService;
  private mintQuoteService: MintQuoteService;
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
    this.mintQuoteService = new MintQuoteService(
      repositories.mintQuoteRepository,
      this.walletService,
      this.proofService,
      this.eventBus,
      mintQuoteLogger,
    );
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

  async getCounter(mintUrl: string, keysetId: string): Promise<number> {
    const counter = await this.counterService.getCounter(mintUrl, keysetId);
    return counter.counter;
  }

  async createMintQuote(mintUrl: string, amount: number): Promise<MintQuoteResponse> {
    return this.mintQuoteService.createMintQuote(mintUrl, amount);
  }

  async redeemMintQuote(mintUrl: string, quoteId: string): Promise<void> {
    return this.mintQuoteService.redeemMintQuote(mintUrl, quoteId);
  }

  async mintQuote(
    mintUrl: string,
    amount: number,
  ): Promise<{
    quote: MintQuoteResponse;
    handlePayment: () => {
      promise: Promise<MintQuoteResponse>;
      unsubscribe: () => void;
    };
  }> {
    return this.mintQuoteService.mintProofs(mintUrl, amount);
  }

  async receive(token: Token | string) {
    const { mint, proofs }: Token = typeof token === 'string' ? getDecodedToken(token) : token;

    const known = await this.mintService.isKnownMint(mint);
    if (!known) {
      throw new UnknownMintError(`Mint ${mint} is not known`);
    }

    const wallet = await this.walletService.getWallet(mint);
    const newProofs = await wallet.receive({ mint, proofs });
    await this.proofService.saveProofsAndIncrementCounters(mint, newProofs);
  }

  async send(mintUrl: string, amount: number): Promise<Token> {
    const cashuWallet = await this.walletService.getWallet(mintUrl);
    const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, amount);
    const { send, keep } = await cashuWallet.send(amount, selectedProofs);
    await this.proofService.saveProofsAndIncrementCounters(mintUrl, keep);
    await this.proofService.setProofState(
      mintUrl,
      send.map((proof) => proof.secret),
      'inflight',
    );
    return {
      mint: mintUrl,
      proofs: send,
    };
  }
}
