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
import { overrideTransactions } from '../overrideTransactions.ts';

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

  beforeEach(() => {
    repositories = new MemoryRepositories();
    repo = repositories.keyRingRepository;
    seedService = new SeedService(async () => MOCK_SEED);
    service = createService(repositories, seedService);
  });

  describe('generateNewKeyPair', () => {
    it('returns only public key by default', async () => {
      const result = await service.generateNewKeyPair();

      expect('publicKeyHex' in result).toBe(true);
      expect('secretKey' in result).toBe(false);
    });

    it('returns only public key when dumpSecretKey is false', async () => {
      const result = await service.generateNewKeyPair({ dumpSecretKey: false });

      expect('publicKeyHex' in result).toBe(true);
      expect('secretKey' in result).toBe(false);
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
  });

  describe('addKeyPair', () => {
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
    it('does not throw when removing non-existent key', async () => {
      // Should complete without throwing
      await service.removeKeyPair(
        '0000000000000000000000000000000000000000000000000000000000000000',
      );
      // If we get here, the test passed
    });
  });

  describe('getKeyPair', () => {
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
    it('returns null after all keypairs are removed', async () => {
      const kp = await service.generateNewKeyPair();
      await service.removeKeyPair(kp.publicKeyHex);

      const latest = await service.getLatestKeyPair();
      expect(latest).toBeNull();

      const next = await service.generateNewKeyPair({ dumpSecretKey: true });
      expect(next.derivationIndex).toBe(1);
    });
  });

  describe('signProof', () => {
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
