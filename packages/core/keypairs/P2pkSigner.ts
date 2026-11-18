import type { Proof } from '@cashu/cashu-ts';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Keypair } from '../models/Keypair.ts';
import type { KeypairQueries } from './KeypairQueries.ts';
import { findP2pkKeyPair } from './P2pkKeyLookup.ts';

/** Signs with existing keys. Never allocates a key or writes Wallet state. */
export interface P2pkSigner {
  /** Signs with the first available key; each supplied key must authorize an entire path. */
  signProof(
    proof: Proof,
    publicKey: string,
    alternativePublicKeys?: readonly string[],
  ): Promise<Proof>;
}

export class KeypairP2pkSigner implements P2pkSigner {
  constructor(private readonly keys: Pick<KeypairQueries, 'getPersistedKeyPair'>) {}

  signProof(
    proof: Proof,
    publicKey: string,
    alternativePublicKeys: readonly string[] = [],
  ): Promise<Proof> {
    return this.signWithKeys(proof, publicKey, alternativePublicKeys);
  }

  /** Reuses resolved keys and misses only across proofs in one receive preparation. */
  forPreparation(): P2pkSigner {
    const resolvedKeys = new Map<string, Keypair | null>();
    return {
      signProof: (proof, publicKey, alternatives = []) =>
        this.signWithKeys(proof, publicKey, alternatives, resolvedKeys),
    };
  }

  private async signWithKeys(
    proof: Proof,
    publicKey: string,
    alternativePublicKeys: readonly string[],
    resolvedKeys?: Map<string, Keypair | null>,
  ): Promise<Proof> {
    if (!proof.secret || typeof proof.secret !== 'string') {
      throw new Error('Proof secret is required and must be a string');
    }
    for (const candidate of [publicKey, ...alternativePublicKeys]) {
      let keyPair = resolvedKeys?.get(candidate);
      if (keyPair === undefined) {
        keyPair = await findP2pkKeyPair(this.keys, candidate);
        resolvedKeys?.set(candidate, keyPair);
      }
      if (!keyPair) continue;
      const signature = schnorr.sign(
        sha256(new TextEncoder().encode(proof.secret)),
        keyPair.secretKey,
      );
      return { ...proof, witness: JSON.stringify({ signatures: [bytesToHex(signature)] }) };
    }
    throw new Error(`Key pair not found for public key: ${publicKey.substring(0, 8)}...`);
  }
}
