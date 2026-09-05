import { describe, expect, it } from 'bun:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Proof } from '@cashu/cashu-ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { KeypairP2pkSigner } from '../../keypairs/P2pkSigner.ts';

describe('shared keypair capabilities', () => {
  it('prepares derivation once and reuses it synchronously without loading the seed again', async () => {
    let reads = 0;
    const derivation = new KeypairDerivation(async () => {
      reads++;
      return new Uint8Array(64);
    });
    const command = await derivation.prepare('p2pk');
    const first = command.derive(0);
    expect(command.derive(0)).toEqual(first);
    expect(command.derive(1).publicKeyHex).not.toBe(first.publicKeyHex);
    expect(reads).toBe(1);
  });

  it('signs through a read-only interface and never creates a missing key', async () => {
    const secretKey = new Uint8Array(32).fill(1);
    const publicKeyHex = '02' + bytesToHex(schnorr.getPublicKey(secretKey));
    const lookups: string[] = [];
    const signer = new KeypairP2pkSigner({
      async getPersistedKeyPair(publicKey, purpose) {
        lookups.push(publicKey);
        expect(purpose).toBe('p2pk');
        return publicKey === publicKeyHex ? { secretKey, publicKeyHex, purpose } : null;
      },
    });
    const proof = { secret: 'proof-secret' } as Proof;
    const signed = await signer.signProof(proof, publicKeyHex);
    if (typeof signed.witness !== 'string') throw new Error('Expected a serialized witness');
    const witness = JSON.parse(signed.witness) as { signatures: string[] };
    expect(
      schnorr.verify(
        hexToBytes(witness.signatures[0]!),
        sha256(new TextEncoder().encode(proof.secret)),
        schnorr.getPublicKey(secretKey),
      ),
    ).toBe(true);
    expect(proof.witness).toBeUndefined();
    await expect(signer.signProof(proof, 'missing')).rejects.toThrow('Key pair not found');
    expect(lookups).toEqual([publicKeyHex, 'missing']);
  });
});
