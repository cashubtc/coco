import { getDecodedToken, type CashuWallet, type Token } from '@cashu/cashu-ts';
import type { Repositories } from './repositories';
import { CounterService, MintService, ProofService, WalletService } from './services';
import { type Mint, type Keyset, UnknownMintError } from './models';
import { EventBus, type CoreEvents } from './events';

export class Manager {
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private proofService: ProofService;
  private eventBus: EventBus<CoreEvents>;

  constructor(repositories: Repositories) {
    this.eventBus = new EventBus<CoreEvents>();
    this.mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      this.eventBus,
    );
    this.walletService = new WalletService(this.mintService);
    this.counterService = new CounterService(repositories.counterRepository, this.eventBus);
    this.proofService = new ProofService(
      this.counterService,
      repositories.proofRepository,
      this.walletService,
      this.eventBus,
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

  async getWallet(mintUrl: string): Promise<{
    wallet: CashuWallet;
    keysetId: string;
  }> {
    const wallet = await this.walletService.getWallet(mintUrl);
    const keysetId = wallet.getActiveKeyset(wallet.keysets).id;
    return { wallet, keysetId };
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

  async mintProofs(mintUrl: string, amount: number): Promise<void> {
    const { wallet, keysetId } = await this.getWallet(mintUrl);
    const quote = await wallet.createMintQuote(amount);
    const proofs = await wallet.mintProofs(amount, quote.quote, { keysetId });
    await this.proofService.saveProofsAndIncrementCounters(mintUrl, proofs);
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
