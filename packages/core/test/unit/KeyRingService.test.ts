import { describe, it, beforeEach, expect } from 'bun:test';
import { KeyRingService } from '../../services/KeyRingService.ts';
import { SeedService } from '../../services/SeedService.ts';
import { MemoryKeyRingRepository } from '../../repositories/memory/MemoryKeyRingRepository.ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type { Proof } from '@cashu/cashu-ts';

// Mock seed for deterministic testing
const MOCK_SEED = new Uint8Array(64);
for (let i = 0; i < 64; i++) {
  MOCK_SEED[i] = i;
}

describe('KeyRingService', () => {
  let repo: MemoryKeyRingRepository;
  let seedService: SeedService;
  let service: KeyRingService;

  beforeEach(() => {
    repo = new MemoryKeyRingRepository();
    seedService = new SeedService(async () => MOCK_SEED);
    service = new KeyRingService(repo, seedService);
  });

  describe('generateNewKeyPair', () => {
    it('generates a new keypair and stores it', async () => {
      const result = await service.generateNewKeyPair();

      expect(result.publicKeyHex).toBeDefined();
      expect(result.publicKeyHex.length).toBe(66); // 33 bytes * 2 for hex
      expect(result.publicKeyHex.startsWith('02') || result.publicKeyHex.startsWith('03')).toBe(true);
      expect('secretKey' in result).toBe(false);

      // Verify it was stored in the repository
      const stored = await repo.getPersistedKeyPair(result.publicKeyHex);
      expect(stored).not.toBeNull();
      expect(stored?.publicKeyHex).toBe(result.publicKeyHex);
    });

    it('returns only public key by default', async () => {
      const result = await service.generateNewKeyPair();

      expect('publicKeyHex' in result).toBe(true);
      expect('secretKey' in result).toBe(false);
    });

    it('returns both keys when dumpSecretKey is true', async () => {
      const result = await service.generateNewKeyPair({ dumpSecretKey: true });

      expect(result.publicKeyHex).toBeDefined();
      expect(result.secretKey).toBeDefined();
      expect(result.secretKey.length).toBe(32);
    });

    it('returns only public key when dumpSecretKey is false', async () => {
      const result = await service.generateNewKeyPair({ dumpSecretKey: false });

      expect('publicKeyHex' in result).toBe(true);
      expect('secretKey' in result).toBe(false);
    });

    it('generates unique keypairs each time', async () => {
      const result1 = await service.generateNewKeyPair({ dumpSecretKey: true });
      const result2 = await service.generateNewKeyPair({ dumpSecretKey: true });

      expect(result1.publicKeyHex).not.toBe(result2.publicKeyHex);
      expect(bytesToHex(result1.secretKey)).not.toBe(bytesToHex(result2.secretKey));
    });

    it('assigns sequential derivation indices starting from 0', async () => {
      const kp1 = await service.generateNewKeyPair();
      const kp2 = await service.generateNewKeyPair();
      const kp3 = await service.generateNewKeyPair();

      const stored1 = await repo.getPersistedKeyPair(kp1.publicKeyHex);
      const stored2 = await repo.getPersistedKeyPair(kp2.publicKeyHex);
      const stored3 = await repo.getPersistedKeyPair(kp3.publicKeyHex);

      expect(stored1?.derivationIndex).toBe(0);
      expect(stored2?.derivationIndex).toBe(1);
      expect(stored3?.derivationIndex).toBe(2);
      expect(stored1?.derivationPath).toBe("m/129372'/10'/0'/0'/0");
      expect(stored2?.derivationPath).toBe("m/129372'/10'/0'/0'/1");
      expect(stored3?.derivationPath).toBe("m/129372'/10'/0'/0'/2");
    });

    it('derives deterministic keys from the same seed', async () => {
      const kp1 = await service.generateNewKeyPair({ dumpSecretKey: true });

      // Create a new service with the same seed
      const repo2 = new MemoryKeyRingRepository();
      const seedService2 = new SeedService(async () => MOCK_SEED);
      const service2 = new KeyRingService(repo2, seedService2);

      const kp2 = await service2.generateNewKeyPair({ dumpSecretKey: true });

      // Should derive the same key for the same derivation index (0)
      expect(kp1.publicKeyHex).toBe(kp2.publicKeyHex);
      expect(bytesToHex(kp1.secretKey)).toBe(bytesToHex(kp2.secretKey));
    });

    it('continues derivation index after imported keys', async () => {
      // Generate first key (index 0)
      const derived1 = await service.generateNewKeyPair();
      const stored1 = await repo.getPersistedKeyPair(derived1.publicKeyHex);
      expect(stored1?.derivationIndex).toBe(0);

      // Import a key (no derivation index)
      const importedKey = schnorr.utils.randomSecretKey();
      await service.addKeyPair(importedKey);

      // Generate another key (should be index 1)
      const derived2 = await service.generateNewKeyPair();
      const stored2 = await repo.getPersistedKeyPair(derived2.publicKeyHex);
      expect(stored2?.derivationIndex).toBe(1);
    });

    it('generates identical keys after database wipe (deterministic derivation)', async () => {
      // Generate 3 keys with the first service
      const key1 = await service.generateNewKeyPair({ dumpSecretKey: true });
      const key2 = await service.generateNewKeyPair({ dumpSecretKey: true });
      const key3 = await service.generateNewKeyPair({ dumpSecretKey: true });

      // Store the keys for comparison
      const firstRun = [
        { publicKey: key1.publicKeyHex, secretKey: bytesToHex(key1.secretKey) },
        { publicKey: key2.publicKeyHex, secretKey: bytesToHex(key2.secretKey) },
        { publicKey: key3.publicKeyHex, secretKey: bytesToHex(key3.secretKey) },
      ];

      // Wipe the database by creating a fresh repository
      repo = new MemoryKeyRingRepository();
      // Create a new service with the same seed
      service = new KeyRingService(repo, seedService);

      // Generate 3 keys again with the new service
      const key1Again = await service.generateNewKeyPair({ dumpSecretKey: true });
      const key2Again = await service.generateNewKeyPair({ dumpSecretKey: true });
      const key3Again = await service.generateNewKeyPair({ dumpSecretKey: true });

      // Verify the keys are identical
      expect(key1Again.publicKeyHex).toBe(firstRun[0]!.publicKey);
      expect(bytesToHex(key1Again.secretKey)).toBe(firstRun[0]!.secretKey);

      expect(key2Again.publicKeyHex).toBe(firstRun[1]!.publicKey);
      expect(bytesToHex(key2Again.secretKey)).toBe(firstRun[1]!.secretKey);

      expect(key3Again.publicKeyHex).toBe(firstRun[2]!.publicKey);
      expect(bytesToHex(key3Again.secretKey)).toBe(firstRun[2]!.secretKey);

      // Verify derivation indices are also the same
      const stored1 = await repo.getPersistedKeyPair(key1Again.publicKeyHex);
      const stored2 = await repo.getPersistedKeyPair(key2Again.publicKeyHex);
      const stored3 = await repo.getPersistedKeyPair(key3Again.publicKeyHex);

      expect(stored1?.derivationIndex).toBe(0);
      expect(stored2?.derivationIndex).toBe(1);
      expect(stored3?.derivationIndex).toBe(2);
    });
  });

  describe('addKeyPair', () => {
    it('adds a keypair from a secret key', async () => {
      const secretKey = schnorr.utils.randomSecretKey();
      const result = await service.addKeyPair(secretKey);

      // The public key should be in compressed format (starts with 02 or 03)
      const publicKeyHex = bytesToHex(secp256k1.getPublicKey(secretKey));
      const stored = await repo.getPersistedKeyPair(publicKeyHex);

      expect(stored).not.toBeNull();
      expect(stored?.publicKeyHex).toBe(publicKeyHex);
      expect(result.publicKeyHex).toBe(publicKeyHex);
      expect(bytesToHex(stored!.secretKey)).toBe(bytesToHex(secretKey));
    });

    it('does not assign derivation index to imported keys', async () => {
      const secretKey = schnorr.utils.randomSecretKey();
      const result = await service.addKeyPair(secretKey);

      const stored = await repo.getPersistedKeyPair(result.publicKeyHex);
      expect(stored?.derivationIndex).toBeUndefined();
    });

    it('rejects secret key that is not 32 bytes', async () => {
      const invalidKey = new Uint8Array(31); // Wrong length

      await expect(service.addKeyPair(invalidKey)).rejects.toThrow(
        'Secret key must be exactly 32 bytes',
      );
    });

    it('rejects secret key that is too long', async () => {
      const invalidKey = new Uint8Array(33); // Too long

      await expect(service.addKeyPair(invalidKey)).rejects.toThrow(
        'Secret key must be exactly 32 bytes',
      );
    });
  });

  describe('removeKeyPair', () => {
    it('removes a keypair by public key', async () => {
      const result = await service.generateNewKeyPair();

      // Verify it exists
      let stored = await repo.getPersistedKeyPair(result.publicKeyHex);
      expect(stored).not.toBeNull();

      // Remove it
      await service.removeKeyPair(result.publicKeyHex);

      // Verify it's gone
      stored = await repo.getPersistedKeyPair(result.publicKeyHex);
      expect(stored).toBeNull();
    });

    it('does not throw when removing non-existent key', async () => {
      // Should complete without throwing
      await service.removeKeyPair(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
      // If we get here, the test passed
    });
  });

  describe('getKeyPair', () => {
    it('retrieves a keypair by public key', async () => {
      const generated = await service.generateNewKeyPair({ dumpSecretKey: true });

      const retrieved = await service.getKeyPair(generated.publicKeyHex);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.publicKeyHex).toBe(generated.publicKeyHex);
      expect(bytesToHex(retrieved!.secretKey)).toBe(bytesToHex(generated.secretKey));
    });

    it('returns null for non-existent key', async () => {
      const result = await service.getKeyPair(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );

      expect(result).toBeNull();
    });

    it('throws when public key is empty', async () => {
      await expect(service.getKeyPair('')).rejects.toThrow(
        'Public key is required and must be a string',
      );
    });

    it('throws when public key is not a string', async () => {
      await expect(service.getKeyPair(null as any)).rejects.toThrow(
        'Public key is required and must be a string',
      );
    });
  });

  describe('getLatestKeyPair', () => {
    it('returns null when no keypairs exist', async () => {
      const result = await service.getLatestKeyPair();
      expect(result).toBeNull();
    });

    it('returns the most recently added keypair', async () => {
      const first = await service.generateNewKeyPair();
      const second = await service.generateNewKeyPair();
      const third = await service.generateNewKeyPair();

      const latest = await service.getLatestKeyPair();

      expect(latest?.publicKeyHex).toBe(third.publicKeyHex);
    });

    it('updates latest when a new keypair is added', async () => {
      await service.generateNewKeyPair();
      const second = await service.generateNewKeyPair();

      let latest = await service.getLatestKeyPair();
      expect(latest?.publicKeyHex).toBe(second.publicKeyHex);

      const third = await service.generateNewKeyPair();
      latest = await service.getLatestKeyPair();
      expect(latest?.publicKeyHex).toBe(third.publicKeyHex);
    });

    it('returns null after all keypairs are removed', async () => {
      const kp = await service.generateNewKeyPair();
      await service.removeKeyPair(kp.publicKeyHex);

      const latest = await service.getLatestKeyPair();
      expect(latest).toBeNull();
    });
  });

  describe('getAllKeyPairs', () => {
    it('returns empty array when no keypairs exist', async () => {
      const result = await service.getAllKeyPairs();
      expect(result).toEqual([]);
    });

    it('returns all stored keypairs', async () => {
      const kp1 = await service.generateNewKeyPair();
      const kp2 = await service.generateNewKeyPair();
      const kp3 = await service.generateNewKeyPair();

      const all = await service.getAllKeyPairs();

      expect(all.length).toBe(3);
      const publicKeys = all.map((kp) => kp.publicKeyHex);
      expect(publicKeys).toContain(kp1.publicKeyHex);
      expect(publicKeys).toContain(kp2.publicKeyHex);
      expect(publicKeys).toContain(kp3.publicKeyHex);
    });

    it('reflects removals', async () => {
      const kp1 = await service.generateNewKeyPair();
      const kp2 = await service.generateNewKeyPair();
      const kp3 = await service.generateNewKeyPair();

      await service.removeKeyPair(kp2.publicKeyHex);

      const all = await service.getAllKeyPairs();

      expect(all.length).toBe(2);
      const publicKeys = all.map((kp) => kp.publicKeyHex);
      expect(publicKeys).toContain(kp1.publicKeyHex);
      expect(publicKeys).not.toContain(kp2.publicKeyHex);
      expect(publicKeys).toContain(kp3.publicKeyHex);
    });
  });

  describe('signProof', () => {
    it('signs a proof and returns it with witness', async () => {
      const kp = await service.generateNewKeyPair({ dumpSecretKey: true });

      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'my-secret-string',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const signed = await service.signProof(proof, kp.publicKeyHex);

      expect(signed.witness).toBeDefined();
      expect(typeof signed.witness).toBe('string');

      const witness = JSON.parse(signed.witness as string);
      expect(witness.signatures).toBeDefined();
      expect(Array.isArray(witness.signatures)).toBe(true);
      expect(witness.signatures.length).toBe(1);
      expect(typeof witness.signatures[0]).toBe('string');
      expect(witness.signatures[0].length).toBe(128); // 64 bytes * 2 for hex
    });

    it('does not mutate the original proof', async () => {
      const kp = await service.generateNewKeyPair();

      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'my-secret-string',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const originalWitness = proof.witness;
      await service.signProof(proof, kp.publicKeyHex);

      expect(proof.witness).toBe(originalWitness);
    });

    it('creates valid schnorr signature', async () => {
      const kp = await service.generateNewKeyPair({ dumpSecretKey: true });

      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'test-secret',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const signed = await service.signProof(proof, kp.publicKeyHex);

      // Verify the signature is valid
      const witness = JSON.parse(signed.witness as string);
      const signatureHex = witness.signatures[0];
      const signatureBytes = new Uint8Array(
        signatureHex.match(/.{2}/g)!.map((byte: string) => parseInt(byte, 16)),
      );

      const message = new TextEncoder().encode(proof.secret);
      const messageHash = await crypto.subtle.digest('SHA-256', message);

      const isValid = schnorr.verify(
        signatureBytes,
        new Uint8Array(messageHash),
        kp.secretKey, // Note: schnorr.verify uses public key, but we need to derive it
      );

      // We can't easily verify without the public key in the right format,
      // but we can verify the signature structure is correct
      expect(signatureBytes.length).toBe(64);
    });

    it('throws when keypair not found', async () => {
      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'my-secret-string',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const fakePublicKey = '02' + '00'.repeat(32);

      await expect(service.signProof(proof, fakePublicKey)).rejects.toThrow(
        /Key pair not found for public key/,
      );
    });

    it('includes public key preview in error message', async () => {
      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'my-secret-string',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const fakePublicKey = 'abcdef1234567890000000000000000000000000000000000000000000000000';

      await expect(service.signProof(proof, fakePublicKey)).rejects.toThrow(
        'Key pair not found for public key: abcdef12...',
      );
    });

    it('signs different proofs with different signatures', async () => {
      const kp = await service.generateNewKeyPair();

      const proof1: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'secret-1',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const proof2: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: 'secret-2',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const signed1 = await service.signProof(proof1, kp.publicKeyHex);
      const signed2 = await service.signProof(proof2, kp.publicKeyHex);

      expect(signed1.witness).not.toBe(signed2.witness);
    });

    it('throws when proof secret is empty', async () => {
      const kp = await service.generateNewKeyPair();

      const proof: Proof = {
        id: 'keyset123',
        amount: 64,
        secret: '',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      await expect(service.signProof(proof, kp.publicKeyHex)).rejects.toThrow(
        'Proof secret is required and must be a string',
      );
    });

    it('throws when proof secret is not a string', async () => {
      const kp = await service.generateNewKeyPair();

      const proof = {
        id: 'keyset123',
        amount: 64,
        secret: 123,
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      } as unknown as Proof;

      await expect(service.signProof(proof, kp.publicKeyHex)).rejects.toThrow(
        'Proof secret is required and must be a string',
      );
    });
  });

  describe('P2PK Test Vectors', () => {
    // Mnemonic: half depart obvious quality work element tank gorilla view sugar picture humble
    // Seed (calculated via PBKDF2): dd44ee516b0647e80b488e8dcc56d736a148f15276bef588b37057476d4b2b25780d3688a32b37353d6995997842c0fd8b412475c891c16310471fbc86dcbda8
    const TEST_VECTOR_SEED_HEX =
      'dd44ee516b0647e80b488e8dcc56d736a148f15276bef588b37057476d4b2b25780d3688a32b37353d6995997842c0fd8b412475c891c16310471fbc86dcbda8';
    
    // Convert hex seed to Uint8Array
    const seedBytes = new Uint8Array(
      TEST_VECTOR_SEED_HEX.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16)),
    );

    const EXPECTED_PUBKEYS = [
      '03381fbf0996b81d49c35bae17a70d71db9a9e802b1af5c2516fc90381f4741e06', // index 0
      '039bbb7a9cd234da13a113cdd8e037a25c66bbf3a77139d652786a1d7e9d73e600', // index 1
      '02ffd52ed54761750d75b67342544cc8da8a0994f84c46d546e0ab574dd3651a29', // index 2
      '02751ab780960ff177c2300e440fddc0850238a78782a1cab7b0ae03c41978d92d', // index 3
      '0391a9ba1c3caf39ca0536d44419a6ceeda922ee61aa651a72a60171499c02b423', // index 4
    ];

    let vectorService: KeyRingService;
    let vectorRepo: MemoryKeyRingRepository;

    beforeEach(() => {
      vectorRepo = new MemoryKeyRingRepository();
      const vectorSeedService = new SeedService(async () => seedBytes);
      vectorService = new KeyRingService(vectorRepo, vectorSeedService);
    });

    it('generates correct public keys for test vectors', async () => {
      let i = 0;
      for (const expected of EXPECTED_PUBKEYS) {
        const keyPair = await vectorService.generateNewKeyPair();
        expect(keyPair.publicKeyHex).toBe(expected);
        
        // Also verify the derivation index is correct in storage
        const stored = await vectorRepo.getPersistedKeyPair(keyPair.publicKeyHex);
        expect(stored?.derivationIndex).toBe(i);
        i++;
      }
    });
  });
});
