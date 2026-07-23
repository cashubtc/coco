import type { KeyRingService } from '@core/services';
import type { Keypair } from '@core/models';

export class KeyRingApi {
  constructor(private readonly keyRingService: KeyRingService) {}

  /**
   * Generates a new keypair and stores it in the keyring.
   * @param dumpSecretKey - If true, returns the full keypair including the secret key.
   *                        If false or omitted, returns only the public key.
   *                        WARNING: The secret key is sensitive cryptographic material. Handle with care.
   * @returns The full keypair (if dumpSecretKey is true) or just the public key (if false/omitted)
   */
  async generateKeyPair(): Promise<{ publicKeyHex: string }>;
  async generateKeyPair(dumpSecretKey: true): Promise<Keypair>;
  async generateKeyPair(dumpSecretKey: false): Promise<{ publicKeyHex: string }>;
  async generateKeyPair(dumpSecretKey?: boolean): Promise<{ publicKeyHex: string } | Keypair> {
    if (dumpSecretKey === true) {
      return this.keyRingService.generateNewKeyPair({ dumpSecretKey: true });
    }
    return this.keyRingService.generateNewKeyPair({ dumpSecretKey: false });
  }

  /**
   * Adds an existing keypair using its canonical compressed public key. If the same secret is
   * already stored under coco's legacy public key encoding, returns that existing keypair.
   * @param secretKey - The 32-byte secret key as Uint8Array
   */
  async addKeyPair(secretKey: Uint8Array): Promise<Keypair> {
    return this.keyRingService.addKeyPair(secretKey);
  }

  /**
   * Removes a keypair from the keyring using its canonical or legacy public key encoding.
   * @param publicKey - A canonical or legacy public key hex string for the keypair to remove
   */
  async removeKeyPair(publicKey: string): Promise<void> {
    return this.keyRingService.removeKeyPair(publicKey);
  }

  /**
   * Retrieves a specific keypair using its canonical or legacy public key encoding.
   * @param publicKey - A canonical or legacy public key hex string to look up
   * @returns The persisted keypair if found, preserving its stored public key encoding
   */
  async getKeyPair(publicKey: string): Promise<Keypair | null> {
    return this.keyRingService.getKeyPair(publicKey);
  }

  /**
   * Gets the most recently added keypair.
   * @returns The latest keypair if any exist, null otherwise
   */
  async getLatestKeyPair(): Promise<Keypair | null> {
    return this.keyRingService.getLatestKeyPair();
  }

  /**
   * Gets all keypairs stored in the keyring.
   * @returns Array of all keypairs
   */
  async getAllKeyPairs(): Promise<Keypair[]> {
    return this.keyRingService.getAllKeyPairs();
  }
}
