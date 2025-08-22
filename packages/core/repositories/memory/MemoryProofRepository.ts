import type { Proof } from "@cashu/cashu-ts";
import type { ProofRepository } from "..";

type ProofState = "inflight" | "ready";

interface StoredProof extends Proof {
  _state: ProofState;
}

export class MemoryProofRepository implements ProofRepository {
  private proofsByMint: Map<string, Map<string, StoredProof>> = new Map();

  private getMintMap(mintUrl: string): Map<string, StoredProof> {
    if (!this.proofsByMint.has(mintUrl)) {
      this.proofsByMint.set(mintUrl, new Map());
    }
    return this.proofsByMint.get(mintUrl)!;
  }

  async saveProofs(mintUrl: string, proofs: Proof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const map = this.getMintMap(mintUrl);
    // Pre-check for any collisions and fail atomically
    for (const p of proofs) {
      if (map.has(p.secret)) {
        throw new Error(`Proof with secret already exists: ${p.secret}`);
      }
    }
    for (const p of proofs) {
      map.set(p.secret, { ...p, _state: "ready" });
    }
  }

  async getReadyProofs(mintUrl: string): Promise<Proof[]> {
    const map = this.getMintMap(mintUrl);
    return Array.from(map.values())
      .filter((p) => p._state === "ready")
      .map(({ _state, ...rest }) => rest as Proof);
  }

  async setProofState(
    mintUrl: string,
    secrets: string[],
    state: ProofState
  ): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const secret of secrets) {
      const p = map.get(secret);
      if (p) map.set(secret, { ...p, _state: state });
    }
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    const map = this.getMintMap(mintUrl);
    for (const s of secrets) map.delete(s);
  }
}
