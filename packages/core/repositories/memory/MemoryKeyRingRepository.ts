import type { Keypair } from '../../models/Keypair';
import type { KeyRingRepository } from '..';

export class MemoryKeyRingRepository implements KeyRingRepository {
  private keyPairs: Map<string, Keypair> = new Map();
  private insertionOrder: string[] = [];

  async getPersistedKeyPair(publicKey: string): Promise<Keypair | null> {
    return this.keyPairs.get(publicKey) ?? null;
  }

  async setPersistedKeyPair(keyPair: Keypair): Promise<void> {
    if (!this.keyPairs.has(keyPair.publicKeyHex)) {
      this.insertionOrder.push(keyPair.publicKeyHex);
    }

    // Preserve existing derivationIndex if new one is not provided
    let derivationIndex = keyPair.derivationIndex;
    if (derivationIndex == null) {
      const existing = this.keyPairs.get(keyPair.publicKeyHex);
      if (existing?.derivationIndex != null) {
        derivationIndex = existing.derivationIndex;
      }
    }

    this.keyPairs.set(keyPair.publicKeyHex, {
      ...keyPair,
      derivationIndex,
    });
  }

  async deletePersistedKeyPair(publicKey: string): Promise<void> {
    this.keyPairs.delete(publicKey);
    const index = this.insertionOrder.indexOf(publicKey);
    if (index !== -1) {
      this.insertionOrder.splice(index, 1);
    }
  }

  async getAllPersistedKeyPairs(): Promise<Keypair[]> {
    return Array.from(this.keyPairs.values());
  }

  async getLatestKeyPair(): Promise<Keypair | null> {
    if (this.insertionOrder.length === 0) {
      return null;
    }
    const latestPublicKey = this.insertionOrder[this.insertionOrder.length - 1];
    return this.keyPairs.get(latestPublicKey!) ?? null;
  }

  async getLastDerivationIndex(): Promise<number> {
    let maxIndex = -1;
    for (const keypair of this.keyPairs.values()) {
      if (keypair.derivationIndex != null && keypair.derivationIndex > maxIndex) {
        maxIndex = keypair.derivationIndex;
      }
    }
    return maxIndex;
  }
}
