import type { Proof } from '@cashu/cashu-ts';
import type { Logger } from '@core/logging';
import type { Keypair, KeypairPurpose } from '@core/models/Keypair';
import type { KeyRingTransactions } from '@core/transactions/keypairs/KeyRingTransactions.ts';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import type { KeypairQueries } from '../keypairs/KeypairQueries.ts';
import type { KeypairDerivation } from '../keypairs/KeypairDerivation.ts';
import type { P2pkSigner } from '../keypairs/P2pkSigner.ts';

export class KeyRingService {
  constructor(
    private readonly keypairQueries: KeypairQueries,
    private readonly transactions: KeyRingTransactions,
    private readonly derivation: KeypairDerivation,
    private readonly signer: P2pkSigner,
    private readonly logger?: Logger,
  ) {}

  async generateNewKeyPair(): Promise<{ publicKeyHex: string }>;
  async generateNewKeyPair(options: { dumpSecretKey: true }): Promise<Keypair>;
  async generateNewKeyPair(options: { dumpSecretKey: false }): Promise<{ publicKeyHex: string }>;
  async generateNewKeyPair(options?: {
    dumpSecretKey?: boolean;
  }): Promise<{ publicKeyHex: string } | Keypair> {
    return this.generateKeyPairForPurpose('p2pk', options);
  }

  async generateMintQuoteKeyPair(): Promise<Keypair> {
    return (await this.generateKeyPairForPurpose('nut20_mint_quote', {
      dumpSecretKey: true,
    })) as Keypair;
  }

  private async generateKeyPairForPurpose(
    purpose: KeypairPurpose,
    options?: {
      dumpSecretKey?: boolean;
    },
  ): Promise<{ publicKeyHex: string } | Keypair> {
    const command = await this.derivation.prepare(purpose);
    const keyPair = await this.transactions.allocate(command);
    if (options?.dumpSecretKey) {
      return keyPair;
    }
    return { publicKeyHex: keyPair.publicKeyHex };
  }

  async addKeyPair(secretKey: Uint8Array): Promise<Keypair> {
    this.logger?.debug('Adding key pair with secret key...');
    if (secretKey.length !== 32) {
      throw new Error('Secret key must be exactly 32 bytes');
    }
    const publicKeyHex = this.getPublicKeyHex(secretKey);
    await this.transactions.importP2pkKey({
      publicKeyHex,
      secretKey,
      purpose: 'p2pk',
    });
    this.logger?.debug('Key pair added', { publicKeyHex });
    return { publicKeyHex, secretKey, purpose: 'p2pk' };
  }

  async removeKeyPair(publicKey: string): Promise<void> {
    this.logger?.debug('Removing key pair', { publicKey });
    await this.transactions.deleteP2pkKey(publicKey);
    this.logger?.debug('Key pair removed', { publicKey });
  }

  async getKeyPair(publicKey: string): Promise<Keypair | null> {
    if (!publicKey || typeof publicKey !== 'string') {
      throw new Error('Public key is required and must be a string');
    }
    return this.keypairQueries.getPersistedKeyPair(publicKey, 'p2pk');
  }

  async getMintQuoteKeyPair(publicKey: string): Promise<Keypair | null> {
    if (!publicKey || typeof publicKey !== 'string') {
      throw new Error('Public key is required and must be a string');
    }
    return this.keypairQueries.getPersistedKeyPair(publicKey, 'nut20_mint_quote');
  }

  async getLatestKeyPair(): Promise<Keypair | null> {
    return this.keypairQueries.getLatestKeyPair('p2pk');
  }

  async getAllKeyPairs(): Promise<Keypair[]> {
    return this.keypairQueries.getAllPersistedKeyPairs('p2pk');
  }

  async signProof(proof: Proof, publicKey: string): Promise<Proof> {
    const signedProof = await this.signer.signProof(proof, publicKey);
    this.logger?.debug('Proof signed successfully', { publicKey });
    return signedProof;
  }

  /**
   * Converts a secret key to its corresponding public key in SEC1 compressed format.
   * Note: schnorr.getPublicKey() returns a 32-byte x-only public key (BIP340).
   * We prepend '02' to create a 33-byte SEC1 compressed format as expected by Cashu.
   */
  private getPublicKeyHex(secretKey: Uint8Array): string {
    const publicKey = schnorr.getPublicKey(secretKey);
    return '02' + bytesToHex(publicKey);
  }
}
