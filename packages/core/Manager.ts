import type { CashuWallet } from "@cashu/cashu-ts";
import type {
  CounterRepository,
  KeysetRepository,
  MintRepository,
} from "./repositories";
import { CounterService } from "./services/CounterService";
import { MintService } from "./services/MintService";
import { WalletService } from "./services/WalletService";
import type { Mint } from "./models/Mint";
import type { Keyset } from "./models/Keyset";
import { EventBus } from "./events/EventBus";
import type { CoreEvents } from "./events/types";

interface Repositories {
  mintRepository: MintRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
}

export class Manager {
  private mintService: MintService;
  private walletService: WalletService;
  private counterService: CounterService;
  private eventBus: EventBus<CoreEvents>;

  constructor(repositories: Repositories) {
    this.eventBus = new EventBus<CoreEvents>();
    this.mintService = new MintService(
      repositories.mintRepository,
      repositories.keysetRepository,
      this.eventBus
    );
    this.walletService = new WalletService(this.mintService);
    this.counterService = new CounterService(
      repositories.counterRepository,
      this.eventBus
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
    handler: (payload: CoreEvents[E]) => void | Promise<void>
  ): () => void {
    return this.eventBus.on(event, handler);
  }

  once<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>
  ): () => void {
    return this.eventBus.once(event, handler);
  }

  off<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>
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

  async getCounter(mintUrl: string, keysetId: string): Promise<number> {
    const counter = await this.counterService.getCounter(mintUrl, keysetId);
    return counter.counter;
  }

  async incrementCounter(
    mintUrl: string,
    keysetId: string,
    number: number
  ): Promise<number> {
    const counter = await this.counterService.incrementCounter(
      mintUrl,
      keysetId,
      number
    );
    return counter.counter;
  }

  // removed duplicate addMint implementation
}
