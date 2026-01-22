import type { Proof } from '@cashu/cashu-ts';
import type { Logger } from '@core/logging';
import type { KeyRingRepository } from '@core/repositories';
import type { Keypair } from '@core/models/Keypair';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { SeedService } from '@core/services/SeedService.ts';
import { HDKey } from '@scure/bip32';

export class KeyRingService {
  private readonly logger?: Logger;
  private readonly keyRingRepository: KeyRingRepository;
  private readonly seedService: SeedService;
  constructor(keyRingRepository: KeyRingRepository, seedService: SeedService, logger?: Logger) {
    this.keyRingRepository = keyRingRepository;
    this.logger = logger;
    this.seedService = seedService;
  }

  async generateNewKeyPair(): Promise<{ publicKeyHex: string }>;
  async generateNewKeyPair(options: { dumpSecretKey: true }): Promise<Keypair>;
  async generateNewKeyPair(options: { dumpSecretKey: false }): Promise<{ publicKeyHex: string }>;
  async generateNewKeyPair(options?: {
    dumpSecretKey?: boolean;
  }): Promise<{ publicKeyHex: string } | Keypair> {
    this.logger?.debug('Generating new key pair');
    const lastDerivationIndex = await this.keyRingRepository.getLastDerivationIndex();
    const nextDerivationIndex = lastDerivationIndex + 1;
    const seed = await this.seedService.getSeed();
    const hdKey = HDKey.fromMasterSeed(seed);
    const derivationPath = `m/129372'/10'/0'/0'/${nextDerivationIndex}`;
    const { privateKey: secretKey } = hdKey.derive(derivationPath);
    if (!secretKey) {
      throw new Error('Failed to derive secret key');
    }
    const publicKeyHex = this.getPublicKeyHex(secretKey);
    await this.keyRingRepository.setPersistedKeyPair({
      publicKeyHex,
      secretKey,
      derivationIndex: nextDerivationIndex,
    });
    this.logger?.debug('New key pair generated', { publicKeyHex });
    if (options?.dumpSecretKey) {
      return { publicKeyHex, secretKey };
    }
    return { publicKeyHex };
  }

  async addKeyPair(secretKey: Uint8Array): Promise<Keypair> {
    this.logger?.debug('Adding key pair with secret key...');
    if (secretKey.length !== 32) {
      throw new Error('Secret key must be exactly 32 bytes');
    }
    const publicKeyHex = this.getPublicKeyHex(secretKey);
    await this.keyRingRepository.setPersistedKeyPair({ publicKeyHex, secretKey });
    this.logger?.debug('Key pair added', { publicKeyHex });
    return { publicKeyHex, secretKey };
  }

  async removeKeyPair(publicKey: string): Promise<void> {
    this.logger?.debug('Removing key pair', { publicKey });
    await this.keyRingRepository.deletePersistedKeyPair(publicKey);
    this.logger?.debug('Key pair removed', { publicKey });
  }

  async getKeyPair(publicKey: string): Promise<Keypair | null> {
    if (!publicKey || typeof publicKey !== 'string') {
      throw new Error('Public key is required and must be a string');
    }
    return this.keyRingRepository.getPersistedKeyPair(publicKey);
  }

  async getLatestKeyPair(): Promise<Keypair | null> {
    return this.keyRingRepository.getLatestKeyPair();
  }

  async getAllKeyPairs(): Promise<Keypair[]> {
    return this.keyRingRepository.getAllPersistedKeyPairs();
  }

  async signProof(proof: Proof, publicKey: string): Promise<Proof> {
    this.logger?.debug('Signing proof', { proof, publicKey });
    if (!proof.secret || typeof proof.secret !== 'string') {
      throw new Error('Proof secret is required and must be a string');
    }
    const keyPair = await this.keyRingRepository.getPersistedKeyPair(publicKey);
    if (!keyPair) {
      const publicKeyPreview = publicKey.substring(0, 8);
      this.logger?.error('Key pair not found', { publicKey });
      throw new Error(`Key pair not found for public key: ${publicKeyPreview}...`);
    }
    const message = new TextEncoder().encode(proof.secret);
    const signature = schnorr.sign(sha256(message), keyPair.secretKey);
    const signedProof = {
      ...proof,
      witness: JSON.stringify({ signatures: [bytesToHex(signature)] }),
    };
    this.logger?.debug('Proof signed successfully', { publicKey });
    return signedProof;
  }

  /**
   * Converts a secret key to its corresponding public key in SEC1 compressed format.
   * Note: secp256k1.getPublicKey() returns a 33-byte compressed public key by default.
   */
  private getPublicKeyHex(secretKey: Uint8Array): string {
    const publicKey = secp256k1.getPublicKey(secretKey);
    return bytesToHex(publicKey);
  }
}
