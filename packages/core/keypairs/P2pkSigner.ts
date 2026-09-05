import type { Proof } from '@cashu/cashu-ts';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { KeypairQueries } from './KeypairQueries.ts';

/** Signs with existing keys. Never allocates a key or writes Wallet state. */
export interface P2pkSigner {
  signProof(proof: Proof, publicKey: string): Promise<Proof>;
}

export class KeypairP2pkSigner implements P2pkSigner {
  constructor(private readonly keys: Pick<KeypairQueries, 'getPersistedKeyPair'>) {}

  async signProof(proof: Proof, publicKey: string): Promise<Proof> {
    if (!proof.secret || typeof proof.secret !== 'string') {
      throw new Error('Proof secret is required and must be a string');
    }
    const keyPair = await this.keys.getPersistedKeyPair(publicKey, 'p2pk');
    if (!keyPair) {
      throw new Error(`Key pair not found for public key: ${publicKey.substring(0, 8)}...`);
    }
    const signature = schnorr.sign(
      sha256(new TextEncoder().encode(proof.secret)),
      keyPair.secretKey,
    );
    return { ...proof, witness: JSON.stringify({ signatures: [bytesToHex(signature)] }) };
  }
}
