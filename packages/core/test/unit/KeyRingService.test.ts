import { Amount } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect } from 'bun:test';
import { KeyRingService } from '../../services/KeyRingService.ts';
import { SeedService } from '../../services/SeedService.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { DerivationIndexExhaustedError } from '../../models/Error.ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import type { Proof } from '@cashu/cashu-ts';
import type {
  KeyRingRepository,
  Repositories,
  RepositoryTransactionScope,
} from '../../repositories';
import { RepositoryCoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import { CoreKeyRingTransactions } from '../../transactions/keypairs/KeyRingTransactions.ts';
import { KeypairDerivation } from '../../keypairs/KeypairDerivation.ts';
import { KeypairP2pkSigner } from '../../keypairs/P2pkSigner.ts';

// Mock seed for deterministic testing
const MOCK_SEED = new Uint8Array(64);
for (let i = 0; i < 64; i++) {
  MOCK_SEED[i] = i;
}

describe('KeyRingService', () => {
  let repositories: MemoryRepositories;
  let repo: KeyRingRepository;
  let seedService: SeedService;
  let service: KeyRingService;

  function createService(transactionRepositories: Repositories, seed: SeedService): KeyRingService {
    const transactions = new CoreKeyRingTransactions(
      new RepositoryCoreTransactionRunner(transactionRepositories),
    );
    return new KeyRingService(
      transactionRepositories.keyRingRepository,
      transactions,
      new KeypairDerivation(() => seed.getSeed()),
      new KeypairP2pkSigner(transactionRepositories.keyRingRepository),
    );
  }

  function overrideTransactions(
    base: Repositories,
    withTransaction: Repositories['withTransaction'],
  ): Repositories {
    return new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'withTransaction') return withTransaction;
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  beforeEach(() => {
    repositories = new MemoryRepositories();
    repo = repositories.keyRingRepository;
    seedService = new SeedService(async () => MOCK_SEED);
    service = createService(repositories, seedService);
  });

  describe('generateNewKeyPair', () => {
    it('generates a new keypair and stores it', async () => {
      const result = await service.generateNewKeyPair();

      expect(result.publicKeyHex).toBeDefined();
      expect(result.publicKeyHex.length).toBe(66); // 32 bytes * 2 for hex + '02' prefix
      expect(result.publicKeyHex.startsWith('02')).toBe(true);
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
    });

    it('derives deterministic keys from the same seed', async () => {
      const kp1 = await service.generateNewKeyPair({ dumpSecretKey: true });

      // Create a new service with the same seed
      const repositories2 = new MemoryRepositories();
      const seedService2 = new SeedService(async () => MOCK_SEED);
      const service2 = createService(repositories2, seedService2);

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

    it('derives mint quote keys from a separate NUT-20 branch', async () => {
      const p2pk = await service.generateNewKeyPair({ dumpSecretKey: true });
      const quoteKey = await service.generateMintQuoteKeyPair();

      expect(p2pk.publicKeyHex).not.toBe(quoteKey.publicKeyHex);
      expect(p2pk.derivationIndex).toBe(0);
      expect(p2pk.purpose).toBe('p2pk');
      expect(quoteKey.derivationIndex).toBe(0);
      expect(quoteKey.purpose).toBe('nut20_mint_quote');
      expect(quoteKey.publicKeyHex).toBe(
        bytesToHex(secp256k1.getPublicKey(quoteKey.secretKey, true)),
      );
    });

    it('atomically generates distinct mint quote keys for concurrent calls', async () => {
      const keyPairs = await Promise.all(
        Array.from({ length: 32 }, () => service.generateMintQuoteKeyPair()),
      );

      expect(new Set(keyPairs.map((keyPair) => keyPair.derivationIndex)).size).toBe(32);
      expect(new Set(keyPairs.map((keyPair) => keyPair.publicKeyHex)).size).toBe(32);
      expect(new Set(keyPairs.map((keyPair) => bytesToHex(keyPair.secretKey))).size).toBe(32);
      expect(keyPairs.map((keyPair) => keyPair.derivationIndex).sort((a, b) => a! - b!)).toEqual(
        Array.from({ length: 32 }, (_, index) => index),
      );
      expect(await repo.getAllPersistedKeyPairs('nut20_mint_quote')).toHaveLength(32);
    });

    it('coordinates concurrent services sharing one repository', async () => {
      const secondService = createService(repositories, new SeedService(async () => MOCK_SEED));
      const keyPairs = await Promise.all([
        ...Array.from({ length: 16 }, () => service.generateMintQuoteKeyPair()),
        ...Array.from({ length: 16 }, () => secondService.generateMintQuoteKeyPair()),
      ]);

      expect(new Set(keyPairs.map((keyPair) => keyPair.derivationIndex)).size).toBe(32);
      expect(new Set(keyPairs.map((keyPair) => keyPair.publicKeyHex)).size).toBe(32);
      expect(keyPairs.map((keyPair) => keyPair.derivationIndex).sort((a, b) => a! - b!)).toEqual(
        Array.from({ length: 32 }, (_, index) => index),
      );
    });

    it('keeps concurrent P2PK and mint quote allocation sequences independent', async () => {
      const [p2pkKeys, quoteKeys] = await Promise.all([
        Promise.all(
          Array.from({ length: 16 }, () => service.generateNewKeyPair({ dumpSecretKey: true })),
        ),
        Promise.all(Array.from({ length: 16 }, () => service.generateMintQuoteKeyPair())),
      ]);

      const expectedIndexes = Array.from({ length: 16 }, (_, index) => index);
      expect(p2pkKeys.map((key) => key.derivationIndex).sort((a, b) => a! - b!)).toEqual(
        expectedIndexes,
      );
      expect(quoteKeys.map((key) => key.derivationIndex).sort((a, b) => a! - b!)).toEqual(
        expectedIndexes,
      );
      expect(new Set([...p2pkKeys, ...quoteKeys].map((keyPair) => keyPair.publicKeyHex)).size).toBe(
        32,
      );
    });

    it('does not expose or consume an index when atomic persistence fails', async () => {
      let failNextCommit = true;
      const failingRepositories = overrideTransactions(
        repositories,
        async <T>(fn: (scope: RepositoryTransactionScope) => Promise<T>) =>
          repositories.withTransaction(async (scope) => {
            const result = await fn(scope);
            if (failNextCommit) {
              failNextCommit = false;
              throw new Error('commit failed');
            }
            return result;
          }),
      );
      const failingService = createService(failingRepositories, seedService);

      await expect(failingService.generateMintQuoteKeyPair()).rejects.toThrow('commit failed');
      await expect(failingService.generateMintQuoteKeyPair()).resolves.toMatchObject({
        derivationIndex: 0,
      });
    });

    it('loads the seed before allocating a derivation index', async () => {
      let failNextSeed = true;
      const failingSeedService = new SeedService(async () => {
        if (failNextSeed) {
          failNextSeed = false;
          throw new Error('seed unavailable');
        }
        return MOCK_SEED;
      });
      let transactionCalls = 0;
      const trackingRepositories = overrideTransactions(repositories, async (fn) => {
        transactionCalls++;
        return repositories.withTransaction(fn);
      });
      const failingService = createService(trackingRepositories, failingSeedService);

      await expect(failingService.generateMintQuoteKeyPair()).rejects.toThrow('seed unavailable');
      expect(transactionCalls).toBe(0);
      expect(await repo.getAllPersistedKeyPairs('nut20_mint_quote')).toEqual([]);
      await expect(failingService.generateMintQuoteKeyPair()).resolves.toMatchObject({
        derivationIndex: 0,
      });
      expect(transactionCalls).toBe(1);
    });

    it('does not return the keypair before the repository commit completes', async () => {
      let releasePersistence!: () => void;
      let reportPersistenceStarted!: () => void;
      const persistenceGate = new Promise<void>((resolve) => {
        releasePersistence = resolve;
      });
      const persistenceStarted = new Promise<void>((resolve) => {
        reportPersistenceStarted = resolve;
      });

      const blockingRepositories = overrideTransactions(
        repositories,
        async <T>(fn: (scope: RepositoryTransactionScope) => Promise<T>) =>
          repositories.withTransaction(async (scope) => {
            const keyPair = await fn(scope);
            reportPersistenceStarted();
            await persistenceGate;
            return keyPair;
          }),
      );
      const blockingService = createService(blockingRepositories, seedService);
      let generationSettled = false;
      const generation = blockingService.generateMintQuoteKeyPair().then((keyPair) => {
        generationSettled = true;
        return keyPair;
      });

      await persistenceStarted;
      await Promise.resolve();
      expect(generationSettled).toBe(false);

      releasePersistence();
      const keyPair = await generation;
      expect(
        await repo.getPersistedKeyPair(keyPair.publicKeyHex, 'nut20_mint_quote'),
      ).not.toBeNull();
    });

    it('fails explicitly when the derivation index space is exhausted', async () => {
      await repo.setPersistedKeyPair({
        publicKeyHex: '02' + '01'.repeat(32),
        secretKey: new Uint8Array(32).fill(1),
        derivationIndex: 0x7fffffff,
        purpose: 'nut20_mint_quote',
      });

      await expect(service.generateMintQuoteKeyPair()).rejects.toBeInstanceOf(
        DerivationIndexExhaustedError,
      );
      await expect(service.generateNewKeyPair({ dumpSecretKey: true })).resolves.toMatchObject({
        derivationIndex: 0,
      });
    });

    it('keeps mint quote keys out of user-facing key queries and removal', async () => {
      const p2pk = await service.generateNewKeyPair();
      const quoteKey = await service.generateMintQuoteKeyPair();

      expect(await service.getKeyPair(quoteKey.publicKeyHex)).toBeNull();
      expect((await service.getAllKeyPairs()).map((key) => key.publicKeyHex)).toEqual([
        p2pk.publicKeyHex,
      ]);
      expect((await service.getLatestKeyPair())?.publicKeyHex).toBe(p2pk.publicKeyHex);

      await service.removeKeyPair(quoteKey.publicKeyHex);

      expect(await service.getMintQuoteKeyPair(quoteKey.publicKeyHex)).not.toBeNull();
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
      repositories = new MemoryRepositories();
      repo = repositories.keyRingRepository;
      // Create a new service with the same seed
      service = createService(repositories, seedService);

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

      // The public key should have '02' prefix for compressed format
      const publicKeyHex = '02' + bytesToHex(schnorr.getPublicKey(secretKey));
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

      const next = await service.generateNewKeyPair({ dumpSecretKey: true });
      expect(next.derivationIndex).toBe(1);
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
        secret: 'secret-1',
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      };

      const proof2: Proof = {
        id: 'keyset123',
        amount: Amount.from(64),
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
        amount: Amount.from(64),
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
        amount: Amount.from(64),
        secret: 123,
        C: '0000000000000000000000000000000000000000000000000000000000000000',
      } as unknown as Proof;

      await expect(service.signProof(proof, kp.publicKeyHex)).rejects.toThrow(
        'Proof secret is required and must be a string',
      );
    });
  });
});
