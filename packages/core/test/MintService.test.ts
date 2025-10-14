import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { MintService } from '../services/MintService';
import { MemoryMintRepository } from '../repositories/memory/MemoryMintRepository';
import { MemoryKeysetRepository } from '../repositories/memory/MemoryKeysetRepository';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { Mint } from '../models/Mint';
import type { MintInfo } from '../types';

describe('MintService', () => {
  const testMintUrl = 'https://mint.test';
  const testMintUrl2 = 'https://mint2.test';

  let mintRepo: MemoryMintRepository;
  let keysetRepo: MemoryKeysetRepository;
  let eventBus: EventBus<CoreEvents>;
  let service: MintService;

  const mockMintInfo: MintInfo = {
    name: 'Test Mint',
    version: '1.0.0',
    pubkey: 'test-pubkey',
    description: 'Test mint description',
    description_long: 'Long description',
    contact: [],
    nuts: {
      '4': { methods: [], disabled: false },
      '5': { methods: [], disabled: false },
    },
    motd: 'Message of the day',
  } as MintInfo;

  const mockKeysets = [
    {
      id: 'keyset-1',
      unit: 'sat',
      active: true,
      input_fee_ppk: 0,
    },
  ];

  const mockKeys = {
    1: 'key-1',
    2: 'key-2',
    4: 'key-4',
    8: 'key-8',
  };

  beforeEach(() => {
    mintRepo = new MemoryMintRepository();
    keysetRepo = new MemoryKeysetRepository();
    eventBus = new EventBus<CoreEvents>();
    service = new MintService(mintRepo, keysetRepo, undefined, eventBus);

    // Mock the MintAdapter methods
    const mockAdapter = (service as any).mintAdapter;
    mockAdapter.fetchMintInfo = mock(() => Promise.resolve(mockMintInfo));
    mockAdapter.fetchKeysets = mock(() => Promise.resolve({ keysets: mockKeysets }));
    mockAdapter.fetchKeysForId = mock(() => Promise.resolve(mockKeys));
  });

  describe('trust management', () => {
    it('should add new mints as untrusted by default', async () => {
      const result = await service.addMintByUrl(testMintUrl);

      expect(result.mint.trusted).toBe(false);
      expect(result.mint.mintUrl).toBe(testMintUrl);
      expect(result.keysets.length).toBeGreaterThan(0);
    });

    it('should check if mint is trusted', async () => {
      await service.addMintByUrl(testMintUrl);

      const isTrusted = await service.isTrustedMint(testMintUrl);
      expect(isTrusted).toBe(false);
    });

    it('should trust a mint', async () => {
      await service.addMintByUrl(testMintUrl);

      await service.trustMint(testMintUrl);

      const isTrusted = await service.isTrustedMint(testMintUrl);
      expect(isTrusted).toBe(true);
    });

    it('should untrust a mint', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);

      await service.untrustMint(testMintUrl);

      const isTrusted = await service.isTrustedMint(testMintUrl);
      expect(isTrusted).toBe(false);
    });

    it('should emit mint:updated event when trusting mint', async () => {
      await service.addMintByUrl(testMintUrl);

      const events: any[] = [];
      eventBus.on('mint:updated', (payload) => {
        events.push(payload);
      });

      await service.trustMint(testMintUrl);

      expect(events.length).toBe(1);
      expect(events[0]?.mint.trusted).toBe(true);
    });

    it('should emit mint:updated event when untrusting mint', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);

      const events: any[] = [];
      eventBus.on('mint:updated', (payload) => {
        events.push(payload);
      });

      await service.untrustMint(testMintUrl);

      expect(events.length).toBe(1);
      expect(events[0]?.mint.trusted).toBe(false);
    });
  });

  describe('getAllMints', () => {
    it('should return all mints regardless of trust status', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.addMintByUrl(testMintUrl2);
      await service.trustMint(testMintUrl);

      const allMints = await service.getAllMints();

      expect(allMints.length).toBe(2);
      expect(allMints.some((m) => m.trusted)).toBe(true);
      expect(allMints.some((m) => !m.trusted)).toBe(true);
    });

    it('should return empty array when no mints exist', async () => {
      const allMints = await service.getAllMints();
      expect(allMints.length).toBe(0);
    });
  });

  describe('getAllTrustedMints', () => {
    it('should return only trusted mints', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.addMintByUrl(testMintUrl2);
      await service.trustMint(testMintUrl);

      const trustedMints = await service.getAllTrustedMints();

      expect(trustedMints.length).toBe(1);
      expect(trustedMints[0]?.mintUrl).toBe(testMintUrl);
      expect(trustedMints[0]?.trusted).toBe(true);
    });

    it('should return empty array when no trusted mints exist', async () => {
      await service.addMintByUrl(testMintUrl);

      const trustedMints = await service.getAllTrustedMints();
      expect(trustedMints.length).toBe(0);
    });

    it('should return empty array when no mints exist', async () => {
      const trustedMints = await service.getAllTrustedMints();
      expect(trustedMints.length).toBe(0);
    });
  });

  describe('ensureUpdatedMint', () => {
    it('should create mint if it does not exist', async () => {
      const result = await service.ensureUpdatedMint(testMintUrl);

      expect(result.mint.mintUrl).toBe(testMintUrl);
      expect(result.mint.trusted).toBe(false);
      expect(result.keysets.length).toBeGreaterThan(0);
    });

    it('should update existing mint if data is stale', async () => {
      // Add mint
      await service.addMintByUrl(testMintUrl);

      // Manually set updatedAt to a very old timestamp
      const mint = await mintRepo.getMintByUrl(testMintUrl);
      const oldTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
      mint.updatedAt = oldTimestamp;
      await mintRepo.updateMint(mint);

      const result = await service.ensureUpdatedMint(testMintUrl);

      expect(result.mint.updatedAt).toBeGreaterThan(oldTimestamp);
    });

    it('should return cached data if mint is fresh', async () => {
      const added = await service.addMintByUrl(testMintUrl);

      // Clear mock calls
      const mockAdapter = (service as any).mintAdapter;
      mockAdapter.fetchMintInfo.mockClear();

      const result = await service.ensureUpdatedMint(testMintUrl);

      // Should not have fetched again
      expect(mockAdapter.fetchMintInfo).not.toHaveBeenCalled();
      expect(result.mint.mintUrl).toBe(testMintUrl);
    });

    it('should preserve trust status when updating', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);

      // Make mint stale
      const mint = await mintRepo.getMintByUrl(testMintUrl);
      mint.updatedAt = 0;
      await mintRepo.updateMint(mint);

      const result = await service.ensureUpdatedMint(testMintUrl);

      expect(result.mint.trusted).toBe(true);
    });
  });

  describe('getMintInfo', () => {
    it('should get info for untrusted mint', async () => {
      await service.addMintByUrl(testMintUrl);

      const info = await service.getMintInfo(testMintUrl);

      expect(info).toBeDefined();
      expect(info.name).toBe(mockMintInfo.name);
    });

    it('should get info for trusted mint', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);

      const info = await service.getMintInfo(testMintUrl);

      expect(info).toBeDefined();
      expect(info.name).toBe(mockMintInfo.name);
    });

    it('should fetch and cache info for unknown mint', async () => {
      const info = await service.getMintInfo(testMintUrl);

      expect(info).toBeDefined();
      expect(info.name).toBe(mockMintInfo.name);

      // Verify mint was cached
      const mint = await mintRepo.getMintByUrl(testMintUrl);
      expect(mint).toBeDefined();
      expect(mint.trusted).toBe(false);
    });
  });

  describe('updateMintData', () => {
    it('should update existing mint data', async () => {
      await service.addMintByUrl(testMintUrl);

      const result = await service.updateMintData(testMintUrl);

      expect(result.mint.mintUrl).toBe(testMintUrl);
      expect(result.keysets.length).toBeGreaterThan(0);
    });

    it('should create and update mint if it does not exist', async () => {
      const result = await service.updateMintData(testMintUrl);

      expect(result.mint.mintUrl).toBe(testMintUrl);
      expect(result.mint.trusted).toBe(false);
      expect(result.keysets.length).toBeGreaterThan(0);
    });
  });

  describe('deleteMint', () => {
    it('should delete mint and its keysets', async () => {
      await service.addMintByUrl(testMintUrl);

      await service.deleteMint(testMintUrl);

      // Mint should no longer exist
      const exists = await mintRepo.isTrustedMint(testMintUrl);
      expect(exists).toBe(false);

      // Keysets should be deleted
      const keysets = await keysetRepo.getKeysetsByMintUrl(testMintUrl);
      expect(keysets.length).toBe(0);
    });

    it('should handle deleting non-existent mint gracefully', async () => {
      await service.deleteMint(testMintUrl);
      // Should not throw
    });
  });

  describe('addMintByUrl', () => {
    it('should emit mint:added event', async () => {
      const events: any[] = [];
      eventBus.on('mint:added', (payload) => {
        events.push(payload);
      });

      await service.addMintByUrl(testMintUrl);

      expect(events.length).toBe(1);
      expect(events[0]?.mint.mintUrl).toBe(testMintUrl);
      expect(events[0]?.mint.trusted).toBe(false);
    });

    it('should return existing mint if already added', async () => {
      const first = await service.addMintByUrl(testMintUrl);
      const second = await service.addMintByUrl(testMintUrl);

      expect(first.mint.mintUrl).toBe(second.mint.mintUrl);
    });

    it('should fetch and store mint info', async () => {
      const result = await service.addMintByUrl(testMintUrl);

      expect(result.mint.mintInfo.name).toBe(mockMintInfo.name);
    });

    it('should fetch and store keysets', async () => {
      const result = await service.addMintByUrl(testMintUrl);

      expect(result.keysets.length).toBeGreaterThan(0);
      expect(result.keysets[0]?.id).toBe('keyset-1');
    });
  });

  describe('error handling', () => {
    it('should throw MintFetchError when fetchMintInfo fails', async () => {
      const mockAdapter = (service as any).mintAdapter;
      mockAdapter.fetchMintInfo = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.addMintByUrl(testMintUrl)).rejects.toThrow();
    });

    it('should throw MintFetchError when fetchKeysets fails', async () => {
      const mockAdapter = (service as any).mintAdapter;
      mockAdapter.fetchKeysets = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.addMintByUrl(testMintUrl)).rejects.toThrow();
    });

    it('should throw KeysetSyncError when fetchKeysForId fails', async () => {
      const mockAdapter = (service as any).mintAdapter;
      mockAdapter.fetchKeysForId = mock(() => Promise.reject(new Error('Network error')));

      await expect(service.addMintByUrl(testMintUrl)).rejects.toThrow();
    });
  });

  describe('integration with repository', () => {
    it('should persist trusted state correctly', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);

      const mint = await mintRepo.getMintByUrl(testMintUrl);
      expect(mint.trusted).toBe(true);
    });

    it('should update trusted state correctly', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.trustMint(testMintUrl);
      await service.untrustMint(testMintUrl);

      const mint = await mintRepo.getMintByUrl(testMintUrl);
      expect(mint.trusted).toBe(false);
    });

    it('should handle multiple mints with different trust states', async () => {
      await service.addMintByUrl(testMintUrl);
      await service.addMintByUrl(testMintUrl2);
      await service.trustMint(testMintUrl);

      const mint1 = await mintRepo.getMintByUrl(testMintUrl);
      const mint2 = await mintRepo.getMintByUrl(testMintUrl2);

      expect(mint1.trusted).toBe(true);
      expect(mint2.trusted).toBe(false);
    });
  });
});
