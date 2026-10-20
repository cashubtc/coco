import { reconcileKeysetKeypairs, type Keyset } from '../../models/Keyset';
import type { KeysetRepository } from '..';
import { cloneMemoryValue, COPY_MEMORY_REPOSITORY_STATE } from './MemoryRepositoryTransaction.ts';

export class MemoryKeysetRepository implements KeysetRepository {
  private keysetsByMint: Map<string, Map<string, Keyset>> = new Map();

  [COPY_MEMORY_REPOSITORY_STATE](source: MemoryKeysetRepository): void {
    this.keysetsByMint = cloneMemoryValue(source.keysetsByMint);
  }

  private getMintMap(mintUrl: string): Map<string, Keyset> {
    if (!this.keysetsByMint.has(mintUrl)) {
      this.keysetsByMint.set(mintUrl, new Map());
    }
    return this.keysetsByMint.get(mintUrl)!;
  }

  async getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]> {
    return Array.from(this.getMintMap(mintUrl).values());
  }

  async getKeysetById(mintUrl: string, id: string): Promise<Keyset | null> {
    return this.getMintMap(mintUrl).get(id) ?? null;
  }

  updateKeyset(keyset: Omit<Keyset, 'keypairs' | 'updatedAt'>): Promise<void> {
    return this.addKeyset({ ...keyset, keypairs: {} });
  }

  async addKeyset(keyset: Omit<Keyset, 'updatedAt'>): Promise<void> {
    const mintMap = this.getMintMap(keyset.mintUrl);
    mintMap.set(keyset.id, {
      ...keyset,
      keypairs: reconcileKeysetKeypairs(
        keyset.mintUrl,
        keyset.id,
        mintMap.get(keyset.id)?.keypairs,
        keyset.keypairs,
      ),
      updatedAt: Math.floor(Date.now() / 1000),
    });
  }

  async deleteKeyset(mintUrl: string, keysetId: string): Promise<void> {
    this.getMintMap(mintUrl).delete(keysetId);
  }
}
