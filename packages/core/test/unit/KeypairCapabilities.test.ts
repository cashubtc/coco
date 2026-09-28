import { describe, expect, it, mock } from 'bun:test';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Proof } from '@cashu/cashu-ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { KeypairP2pkSigner } from '../../keypairs/P2pkSigner.ts';
import { findP2pkKeyPair } from '../../keypairs/P2pkKeyLookup.ts';
import { MemoryKeyRingRepository } from '../../repositories/memory/MemoryKeyRingRepository.ts';

describe('shared keypair capabilities', () => {
  it('prepares derivation once and reuses it synchronously without loading the seed again', async () => {
    let reads = 0;
    const derivation = new KeypairDerivation(async () => {
      reads++;
      return new Uint8Array(64);
    });
    const input = await derivation.prepare('p2pk');
    const first = input.derive(0);
    expect(input.derive(0)).toEqual(first);
    expect(input.derive(1).publicKeyHex).not.toBe(first.publicKeyHex);
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

describe('P2PK alias lookup and signing', () => {
  const secretKey = Uint8Array.from([...new Uint8Array(31), 6]);
  const canonicalKey = '03fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556';
  const legacyKey = '02' + canonicalKey.slice(2);

  it.each([
    [canonicalKey, legacyKey],
    [legacyKey, canonicalKey],
  ])('signs using stored %s through alias %s with two reads', async (storedKey, alias) => {
    const repository = new MemoryKeyRingRepository();
    await repository.setPersistedKeyPair({ publicKeyHex: storedKey, secretKey, purpose: 'p2pk' });
    const getPersistedKeyPair = mock(repository.getPersistedKeyPair.bind(repository));
    const signer = new KeypairP2pkSigner({ getPersistedKeyPair });
    const proof = { secret: 'proof-secret' } as Proof;
    const signed = await signer.signProof(proof, alias);
    const witness = JSON.parse(signed.witness as string) as { signatures: string[] };

    expect(
      schnorr.verify(
        hexToBytes(witness.signatures[0]!),
        sha256(new TextEncoder().encode(proof.secret)),
        hexToBytes(alias.slice(2)),
      ),
    ).toBe(true);
    expect(getPersistedKeyPair).toHaveBeenCalledTimes(2);
    expect(getPersistedKeyPair).toHaveBeenNthCalledWith(1, alias, 'p2pk');
    expect(getPersistedKeyPair).toHaveBeenNthCalledWith(2, storedKey, 'p2pk');
    expect(proof.witness).toBeUndefined();
  });

  it('does not treat the opposite parity of an even-Y key as a legacy alias', async () => {
    const repository = new MemoryKeyRingRepository();
    const evenSecret = Uint8Array.from([...new Uint8Array(31), 1]);
    const publicKeyHex = bytesToHex(secp256k1.getPublicKey(evenSecret, true));
    expect(publicKeyHex.startsWith('02')).toBe(true);
    await repository.setPersistedKeyPair({ publicKeyHex, secretKey: evenSecret, purpose: 'p2pk' });

    expect(await findP2pkKeyPair(repository, '03' + publicKeyHex.slice(2))).toBeNull();
  });

  it('keeps mint quote keys out of both direct and alias signing', async () => {
    const repository = new MemoryKeyRingRepository();
    await repository.setPersistedKeyPair({
      publicKeyHex: canonicalKey,
      secretKey,
      purpose: 'nut20_mint_quote',
    });
    const signer = new KeypairP2pkSigner(repository);
    for (const publicKey of [canonicalKey, legacyKey]) {
      expect(await findP2pkKeyPair(repository, publicKey)).toBeNull();
      await expect(
        signer.signProof({ secret: 'proof-secret' } as Proof, publicKey),
      ).rejects.toThrow('Key pair not found');
    }
  });

  it('bounds absent-key lookups and does not derive from unrelated stored secrets', async () => {
    const repository = new MemoryKeyRingRepository();
    await repository.setPersistedKeyPair({
      publicKeyHex: canonicalKey,
      secretKey: new Uint8Array(32),
      purpose: 'p2pk',
    });
    const getPersistedKeyPair = mock(repository.getPersistedKeyPair.bind(repository));
    expect(await findP2pkKeyPair({ getPersistedKeyPair }, '02' + '11'.repeat(32))).toBeNull();
    expect(getPersistedKeyPair).toHaveBeenCalledTimes(2);
    getPersistedKeyPair.mockClear();
    expect(await findP2pkKeyPair({ getPersistedKeyPair }, 'missing')).toBeNull();
    expect(getPersistedKeyPair).toHaveBeenCalledTimes(1);
  });
});
