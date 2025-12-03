import type { ProofRepository } from '..';
import type { CoreProof, ProofState } from '../../types';

export class MemoryProofRepository implements ProofRepository {
  private proofsByMint: Map<string, Map<string, CoreProof>> = new Map();

  private getMintMap(mintUrl: string): Map<string, CoreProof> {
    if (!this.proofsByMint.has(mintUrl)) {
      this.proofsByMint.set(mintUrl, new Map());
    }
    return this.proofsByMint.get(mintUrl)!;
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const map = this.getMintMap(mintUrl);
    // Pre-check for any collisions and fail atomically
    for (const p of proofs) {
      if (map.has(p.secret)) {
        throw new Error(`Proof with secret already exists: ${p.secret}`);
      }
    }
    for (const p of proofs) {
      map.set(p.secret, { ...p, mintUrl });
    }
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    return Array.from(map.values())
      .filter((p) => p.state === 'ready')
      .map((p) => ({ ...p }));
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const all: CoreProof[] = [];
    for (const map of this.proofsByMint.values()) {
      for (const p of map.values()) {
        if (p.state === 'ready') {
          all.push({ ...p });
        }
      }
    }
    return all;
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    const results: CoreProof[] = [];
    for (const p of map.values()) {
      if (p.state === 'ready' && p.id === keysetId) {
        results.push({ ...p });
      }
    }
    return results;
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const secret of secrets) {
      const p = map.get(secret);
      if (p) map.set(secret, { ...p, state });
    }
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const s of secrets) map.delete(s);
  }

  async wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const [secret, p] of Array.from(map.entries())) {
      if (p.id === keysetId) {
        map.delete(secret);
      }
    }
  }

  async reserveProofs(mintUrl: string, secrets: string[], operationId: string): Promise<void> {
    const map = this.getMintMap(mintUrl);
    // Pre-check: all proofs must exist, be ready, and not already reserved
    for (const secret of secrets) {
      const p = map.get(secret);
      if (!p) {
        throw new Error(`Proof with secret not found: ${secret}`);
      }
      if (p.state !== 'ready') {
        throw new Error(`Proof is not ready, cannot reserve: ${secret}`);
      }
      if (p.usedByOperationId) {
        throw new Error(`Proof already reserved by operation ${p.usedByOperationId}: ${secret}`);
      }
    }
    // Apply reservation
    for (const secret of secrets) {
      const p = map.get(secret)!;
      map.set(secret, { ...p, usedByOperationId: operationId });
    }
  }

  async releaseProofs(mintUrl: string, secrets: string[]): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const secret of secrets) {
      const p = map.get(secret);
      if (p) {
        const { usedByOperationId: _, ...rest } = p;
        map.set(secret, rest as CoreProof);
      }
    }
  }

  async setCreatedByOperation(
    mintUrl: string,
    secrets: string[],
    operationId: string,
  ): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const secret of secrets) {
      const p = map.get(secret);
      if (p) {
        map.set(secret, { ...p, createdByOperationId: operationId });
      }
    }
  }

  async getProofBySecret(mintUrl: string, secret: string): Promise<CoreProof | null> {
    const map = this.getMintMap(mintUrl);
    const proof = map.get(secret);
    return proof ? { ...proof } : null;
  }

  async getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    const results: CoreProof[] = [];
    for (const p of map.values()) {
      if (p.usedByOperationId === operationId || p.createdByOperationId === operationId) {
        results.push({ ...p });
      }
    }
    return results;
  }

  async getAvailableProofs(mintUrl: string): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    return Array.from(map.values())
      .filter((p) => p.state === 'ready' && !p.usedByOperationId)
      .map((p) => ({ ...p }));
  }

  async getReservedProofs(): Promise<CoreProof[]> {
    const all: CoreProof[] = [];
    for (const map of this.proofsByMint.values()) {
      for (const p of map.values()) {
        if (p.state === 'ready' && p.usedByOperationId) {
          all.push({ ...p });
        }
      }
    }
    return all;
  }
}
