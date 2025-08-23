import type { Mint } from '../../models/Mint';
import type { MintRepository } from '..';

export class MemoryMintRepository implements MintRepository {
  private mints: Map<string, Mint> = new Map();

  async isKnownMint(mintUrl: string): Promise<boolean> {
    return this.mints.has(mintUrl);
  }

  async getMintByUrl(mintUrl: string): Promise<Mint> {
    const mint = this.mints.get(mintUrl);
    if (!mint) {
      throw new Error(`Mint not found: ${mintUrl}`);
    }
    return mint;
  }

  async getAllMints(): Promise<Mint[]> {
    return Array.from(this.mints.values());
  }

  async addNewMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, mint);
  }

  async updateMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, mint);
  }

  async deleteMint(mintUrl: string): Promise<void> {
    this.mints.delete(mintUrl);
  }
}
