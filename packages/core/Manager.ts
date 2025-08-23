import { getDecodedToken, type CashuWallet, type Proof, type Token } from '@cashu/cashu-ts';
import type { Repositories } from './repositories';
import { CounterService, MintService, ProofService, WalletService } from './services';
import { type Mint, type Keyset, UnknownMintError } from './models';
import { EventBus, type CoreEvents } from './events';

// Repositories interface is imported from ./repositories

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
    const decoded: Token = typeof token === 'string' ? getDecodedToken(token) : token;

    const entries = this.normalizeTokenToEntries(decoded);
    if (entries.length === 0) return;

    // Ensure all mints are known up-front
    await Promise.all(
      entries.map(async (entry) => {
        const known = await this.mintService.isKnownMint(entry.mint);
        if (!known) {
          throw new UnknownMintError(`Mint ${entry.mint} is not known`);
        }
      }),
    );

    await Promise.all(
      entries.map(async (entry) => {
        const wallet = await this.walletService.getWallet(entry.mint);
        const singleMintToken = { token: [entry] } as unknown as Token;
        const newProofs = await wallet.receive(singleMintToken);
        await this.proofService.saveProofsAndIncrementCounters(entry.mint, newProofs);
      }),
    );
  }

  private normalizeTokenToEntries(token: Token): Array<{ mint: string; proofs: Proof[] }> {
    const t = token as unknown as {
      mint?: string;
      proofs?: Proof[];
      token?: Array<{ mint: string; proofs: Proof[] }>;
    };

    if (t && typeof t.mint === 'string' && Array.isArray(t.proofs)) {
      return [{ mint: t.mint, proofs: t.proofs }];
    }

    if (t && Array.isArray(t.token)) {
      // Filter out any malformed entries defensively
      return t.token.filter((e) => typeof e.mint === 'string' && Array.isArray(e.proofs));
    }

    return [];
  }

  async incrementCounter(mintUrl: string, keysetId: string, number: number): Promise<number> {
    const counter = await this.counterService.incrementCounter(mintUrl, keysetId, number);
    return counter.counter;
  }

  // removed duplicate addMint implementation
}
