import type { Mint } from '../../models/Mint';
import type { MintRepository } from '..';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryMintRepository implements MintRepository {
  private mints: Map<string, Mint> = new Map();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryMintRepository): void {
    this.mints = cloneMemoryValue(source.mints);
  }

  async isTrustedMint(mintUrl: string): Promise<boolean> {
    const mint = this.mints.get(mintUrl);
    return mint?.trusted ?? false;
  }

  async getMintByUrl(mintUrl: string): Promise<Mint> {
    const mint = this.mints.get(mintUrl);
    if (!mint) {
      throw new Error(`Mint not found: ${mintUrl}`);
    }
    return cloneMemoryValue(mint);
  }

  async findMintByUrl(mintUrl: string): Promise<Mint | null> {
    return cloneMemoryValue(this.mints.get(mintUrl) ?? null);
  }

  async getAllMints(): Promise<Mint[]> {
    return Array.from(this.mints.values(), (mint) => cloneMemoryValue(mint));
  }

  async getAllTrustedMints(): Promise<Mint[]> {
    return Array.from(this.mints.values())
      .filter((mint) => mint.trusted)
      .map((mint) => cloneMemoryValue(mint));
  }

  async addNewMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, cloneMemoryValue(mint));
  }

  async addOrUpdateMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, cloneMemoryValue(mint));
  }

  async updateMint(mint: Mint): Promise<void> {
    this.mints.set(mint.mintUrl, cloneMemoryValue(mint));
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
