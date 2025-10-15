import type { Mint } from '../../models/Mint';
import type { MintRepository } from '..';

export class MemoryMintRepository implements MintRepository {
  private mints: Map<string, Mint> = new Map();

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    const mint = this.mints.get(mintUrl);
    return mint?.trusted ?? false;
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

  async getAllTrustedMints(): Promise<Mint[]> {
    return Array.from(this.mints.values()).filter((mint) => mint.trusted);
  }

  async addNewMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, mint);
  }

  async addOrUpdateMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, mint);
  }

  async updateMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, mint);
  }

  async setMintTrusted(mintUrl: string, trusted: boolean): Promise<void> {
    const mint = this.mints.get(mintUrl);
    if (mint) {
      mint.trusted = trusted;
      this.mints.set(mintUrl, mint);
    }
  }

  async deleteMint(mintUrl: string): Promise<void> {
    this.mints.delete(mintUrl);
  }
}
