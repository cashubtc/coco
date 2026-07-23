import type { ProofRepository, ProofUnitFilter } from '..';
import type { CoreProof, ProofState } from '../../types';
import { normalizeUnit } from '../../amounts.ts';

function normalizeProofUnit(proof: CoreProof): string {
  return normalizeUnit((proof as { unit?: string }).unit);
}

function getUnitFilter(filter?: ProofUnitFilter): Set<string> | undefined {
  const units = [...(filter?.units ?? []), ...(filter?.unit ? [filter.unit] : [])];
  if (units.length === 0) return undefined;
  return new Set(units.map((unit) => normalizeUnit(unit)));
}

function matchesUnit(proof: CoreProof, unitFilter?: Set<string>): boolean {
  return !unitFilter || unitFilter.has(normalizeProofUnit(proof));
}

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
    const normalizedProofs = proofs.map((proof) => ({
      ...proof,
      unit: normalizeProofUnit(proof),
    }));
    // Pre-check for any collisions and fail atomically
    for (const p of normalizedProofs) {
      if (map.has(p.secret)) {
        throw new Error(`Proof with secret already exists: ${p.secret}`);
      }
    }
    for (const p of normalizedProofs) {
      map.set(p.secret, { ...p, mintUrl });
    }
  }

  async getReadyProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    const unitFilter = getUnitFilter(filter);
    return Array.from(map.values())
      .filter((p) => p.state === 'ready' && matchesUnit(p, unitFilter))
      .map((p) => ({ ...p }));
  }

  async getInflightProofs(mintUrls?: string[], filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const unitFilter = getUnitFilter(filter);
    if (!mintUrls || mintUrls.length === 0) {
      const all: CoreProof[] = [];
      for (const map of this.proofsByMint.values()) {
        for (const p of map.values()) {
          if (p.state === 'inflight' && matchesUnit(p, unitFilter)) {
            all.push({ ...p });
          }
        }
      }
      return all;
    }
    const mintUrlList = mintUrls.map((url) => url.trim()).filter((url) => url.length > 0);
    if (mintUrlList.length === 0) return [];
    const uniqueMintUrls = Array.from(new Set(mintUrlList));
    const results: CoreProof[] = [];
    for (const mintUrl of uniqueMintUrls) {
      const map = this.proofsByMint.get(mintUrl);
      if (!map) continue;
      for (const p of map.values()) {
        if (p.state === 'inflight' && matchesUnit(p, unitFilter)) {
          results.push({ ...p });
        }
      }
    }
    return results;
  }

  async getAllReadyProofs(filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const unitFilter = getUnitFilter(filter);
    const all: CoreProof[] = [];
    for (const map of this.proofsByMint.values()) {
      for (const p of map.values()) {
        if (p.state === 'ready' && matchesUnit(p, unitFilter)) {
          all.push({ ...p });
        }
      }
    }
    return all;
  }

  async getProofsByKeysetId(
    mintUrl: string,
    keysetId: string,
    filter?: ProofUnitFilter,
  ): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    const unitFilter = getUnitFilter(filter);
    const results: CoreProof[] = [];
    for (const p of map.values()) {
      if (p.state === 'ready' && p.id === keysetId && matchesUnit(p, unitFilter)) {
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

  async getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]> {
    if (!secrets || secrets.length === 0) {
      return [];
    }

    const map = this.getMintMap(mintUrl);
    const uniqueSecrets = Array.from(new Set(secrets));
    const proofs: CoreProof[] = [];

    for (const secret of uniqueSecrets) {
      const proof = map.get(secret);
      if (proof) {
        proofs.push({ ...proof });
      }
    }

    return proofs;
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

  async getProofsByAttemptId(mintUrl: string, attemptId: string): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    return Array.from(map.values())
      .filter((proof) => proof.createdByAttemptId === attemptId)
      .map((proof) => ({ ...proof }));
  }

  async getAvailableProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const map = this.getMintMap(mintUrl);
    const unitFilter = getUnitFilter(filter);
    return Array.from(map.values())
      .filter((p) => p.state === 'ready' && !p.usedByOperationId && matchesUnit(p, unitFilter))
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
