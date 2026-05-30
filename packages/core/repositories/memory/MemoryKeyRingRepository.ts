import type { Keypair, KeypairPurpose } from '../../models/Keypair';
import type { KeyRingRepository } from '..';

const DEFAULT_KEYPAIR_PURPOSE: KeypairPurpose = 'p2pk';

export class MemoryKeyRingRepository implements KeyRingRepository {
  private keyPairs: Map<string, Keypair> = new Map();
  private insertionOrder: string[] = [];

  async getPersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<Keypair | null> {
    const keyPair = this.keyPairs.get(publicKey) ?? null;
    if (!keyPair || !purpose) return keyPair;
    return (keyPair.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose ? keyPair : null;
  }

  async setPersistedKeyPair(keyPair: Keypair): Promise<void> {
    if (!this.keyPairs.has(keyPair.publicKeyHex)) {
      this.insertionOrder.push(keyPair.publicKeyHex);
    }

    // Preserve existing derivationIndex if new one is not provided
    const existing = this.keyPairs.get(keyPair.publicKeyHex);
    let derivationIndex = keyPair.derivationIndex;
    if (derivationIndex == null) {
      if (existing?.derivationIndex != null) {
        derivationIndex = existing.derivationIndex;
      }
    }

    this.keyPairs.set(keyPair.publicKeyHex, {
      ...keyPair,
      derivationIndex,
      purpose: keyPair.purpose ?? existing?.purpose ?? DEFAULT_KEYPAIR_PURPOSE,
    });
  }

  async deletePersistedKeyPair(publicKey: string, purpose?: KeypairPurpose): Promise<void> {
    if (purpose) {
      const existing = this.keyPairs.get(publicKey);
      if (existing && (existing.purpose ?? DEFAULT_KEYPAIR_PURPOSE) !== purpose) return;
    }

    this.keyPairs.delete(publicKey);
    const index = this.insertionOrder.indexOf(publicKey);
    if (index !== -1) {
      this.insertionOrder.splice(index, 1);
    }
  }

  async getAllPersistedKeyPairs(purpose?: KeypairPurpose): Promise<Keypair[]> {
    const values = Array.from(this.keyPairs.values());
    if (!purpose) return values;
    return values.filter((keyPair) => (keyPair.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose);
  }

  async getLatestKeyPair(purpose?: KeypairPurpose): Promise<Keypair | null> {
    for (let i = this.insertionOrder.length - 1; i >= 0; i--) {
      const keyPair = this.keyPairs.get(this.insertionOrder[i]!);
      if (!keyPair) continue;
      if (!purpose || (keyPair.purpose ?? DEFAULT_KEYPAIR_PURPOSE) === purpose) return keyPair;
    }

    return null;
  }

  async getLastDerivationIndex(purpose?: KeypairPurpose): Promise<number> {
    let maxIndex = -1;
    for (const keypair of this.keyPairs.values()) {
      if (purpose && (keypair.purpose ?? DEFAULT_KEYPAIR_PURPOSE) !== purpose) continue;
      if (keypair.derivationIndex != null && keypair.derivationIndex > maxIndex) {
        maxIndex = keypair.derivationIndex;
      }
    }
    return maxIndex;
  }
}
