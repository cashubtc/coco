import { describe, it, beforeEach, expect } from 'bun:test';
import { MemoryMintRepository } from '../repositories/memory/MemoryMintRepository';
import type { MintRepository } from '../repositories';
import type { Mint } from '../models/Mint';

/**
 * Shared test suite for MintRepository implementations
 * Tests the trust functionality across all storage backends
 */
export function testMintRepository(name: string, createRepository: () => Promise<MintRepository>) {
  describe(`${name} - Trust Functionality`, () => {
    let repo: MintRepository;

    const createTestMint = (mintUrl: string, trusted: boolean): Mint => ({
      mintUrl,
      name: `Test Mint ${mintUrl}`,
      mintInfo: {
        name: `Test Mint ${mintUrl}`,
        version: '1.0.0',
        pubkey: 'test-pubkey',
        description: 'Test description',
        description_long: 'Long description',
        contact: [],
        //@ts-ignore
        nuts: {},
        motd: 'MOTD',
      },
      trusted,
      createdAt: Math.floor(Date.now() / 1000),
      updatedAt: Math.floor(Date.now() / 1000),
    });

    beforeEach(async () => {
      repo = await createRepository();
    });

    describe('isTrustedMint', () => {
      it('should return false for non-existent mint', async () => {
        const isTrusted = await repo.isTrustedMint('https://non-existent.mint');
        expect(isTrusted).toBe(false);
      });

      it('should return false for untrusted mint', async () => {
        const mint = createTestMint('https://untrusted.mint', false);
        await repo.addNewMint(mint);

        const isTrusted = await repo.isTrustedMint(mint.mintUrl);
        expect(isTrusted).toBe(false);
      });

      it('should return true for trusted mint', async () => {
        const mint = createTestMint('https://trusted.mint', true);
        await repo.addNewMint(mint);

        const isTrusted = await repo.isTrustedMint(mint.mintUrl);
        expect(isTrusted).toBe(true);
      });
    });

    describe('addNewMint', () => {
      it('should add untrusted mint', async () => {
        const mint = createTestMint('https://new.mint', false);
        await repo.addNewMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(false);
      });

      it('should add trusted mint', async () => {
        const mint = createTestMint('https://new.mint', true);
        await repo.addNewMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
      });

      it('should preserve all mint properties including trusted field', async () => {
        const mint = createTestMint('https://new.mint', true);
        await repo.addNewMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.mintUrl).toBe(mint.mintUrl);
        expect(retrieved.name).toBe(mint.name);
        expect(retrieved.trusted).toBe(mint.trusted);
        expect(retrieved.mintInfo.name).toBe(mint.mintInfo.name);
      });
    });

    describe('addOrUpdateMint', () => {
      it('should add new mint as untrusted', async () => {
        const mint = createTestMint('https://new.mint', false);
        await repo.addOrUpdateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(false);
      });

      it('should add new mint as trusted', async () => {
        const mint = createTestMint('https://new.mint', true);
        await repo.addOrUpdateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
      });

      it('should update existing mint trust status', async () => {
        const mint = createTestMint('https://existing.mint', false);
        await repo.addOrUpdateMint(mint);

        mint.trusted = true;
        mint.updatedAt = Math.floor(Date.now() / 1000) + 1;
        await repo.addOrUpdateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
      });

      it('should preserve createdAt on update', async () => {
        const mint = createTestMint('https://existing.mint', false);
        await repo.addOrUpdateMint(mint);

        const originalCreatedAt = mint.createdAt;
        mint.trusted = true;
        mint.updatedAt = Math.floor(Date.now() / 1000) + 10;
        await repo.addOrUpdateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.createdAt).toBe(originalCreatedAt);
      });
    });

    describe('setMintTrusted', () => {
      it('should set mint to trusted', async () => {
        const mint = createTestMint('https://test.mint', false);
        await repo.addNewMint(mint);

        await repo.setMintTrusted(mint.mintUrl, true);

        const isTrusted = await repo.isTrustedMint(mint.mintUrl);
        expect(isTrusted).toBe(true);
      });

      it('should set mint to untrusted', async () => {
        const mint = createTestMint('https://test.mint', true);
        await repo.addNewMint(mint);

        await repo.setMintTrusted(mint.mintUrl, false);

        const isTrusted = await repo.isTrustedMint(mint.mintUrl);
        expect(isTrusted).toBe(false);
      });

      it('should toggle trust status multiple times', async () => {
        const mint = createTestMint('https://test.mint', false);
        await repo.addNewMint(mint);

        await repo.setMintTrusted(mint.mintUrl, true);
        expect(await repo.isTrustedMint(mint.mintUrl)).toBe(true);

        await repo.setMintTrusted(mint.mintUrl, false);
        expect(await repo.isTrustedMint(mint.mintUrl)).toBe(false);

        await repo.setMintTrusted(mint.mintUrl, true);
        expect(await repo.isTrustedMint(mint.mintUrl)).toBe(true);
      });
    });

    describe('getAllMints', () => {
      it('should return all mints regardless of trust status', async () => {
        const mint1 = createTestMint('https://mint1.test', false);
        const mint2 = createTestMint('https://mint2.test', true);
        const mint3 = createTestMint('https://mint3.test', false);

        await repo.addNewMint(mint1);
        await repo.addNewMint(mint2);
        await repo.addNewMint(mint3);

        const allMints = await repo.getAllMints();
        expect(allMints.length).toBe(3);
        expect(allMints.filter((m) => m.trusted).length).toBe(1);
        expect(allMints.filter((m) => !m.trusted).length).toBe(2);
      });

      it('should return empty array when no mints exist', async () => {
        const allMints = await repo.getAllMints();
        expect(allMints.length).toBe(0);
      });

      it('should preserve trusted field for all mints', async () => {
        const mint1 = createTestMint('https://mint1.test', false);
        const mint2 = createTestMint('https://mint2.test', true);

        await repo.addNewMint(mint1);
        await repo.addNewMint(mint2);

        const allMints = await repo.getAllMints();
        const retrieved1 = allMints.find((m) => m.mintUrl === mint1.mintUrl);
        const retrieved2 = allMints.find((m) => m.mintUrl === mint2.mintUrl);

        expect(retrieved1?.trusted).toBe(false);
        expect(retrieved2?.trusted).toBe(true);
      });
    });

    describe('getAllTrustedMints', () => {
      it('should return only trusted mints', async () => {
        const mint1 = createTestMint('https://mint1.test', false);
        const mint2 = createTestMint('https://mint2.test', true);
        const mint3 = createTestMint('https://mint3.test', true);
        const mint4 = createTestMint('https://mint4.test', false);

        await repo.addNewMint(mint1);
        await repo.addNewMint(mint2);
        await repo.addNewMint(mint3);
        await repo.addNewMint(mint4);

        const trustedMints = await repo.getAllTrustedMints();
        expect(trustedMints.length).toBe(2);
        expect(trustedMints.every((m) => m.trusted)).toBe(true);
        expect(trustedMints.map((m) => m.mintUrl).sort()).toEqual(
          [mint2.mintUrl, mint3.mintUrl].sort(),
        );
      });

      it('should return empty array when no trusted mints exist', async () => {
        const mint1 = createTestMint('https://mint1.test', false);
        const mint2 = createTestMint('https://mint2.test', false);

        await repo.addNewMint(mint1);
        await repo.addNewMint(mint2);

        const trustedMints = await repo.getAllTrustedMints();
        expect(trustedMints.length).toBe(0);
      });

      it('should return empty array when no mints exist', async () => {
        const trustedMints = await repo.getAllTrustedMints();
        expect(trustedMints.length).toBe(0);
      });

      it('should update when trust status changes', async () => {
        const mint = createTestMint('https://mint.test', false);
        await repo.addNewMint(mint);

        expect((await repo.getAllTrustedMints()).length).toBe(0);

        await repo.setMintTrusted(mint.mintUrl, true);

        const trustedMints = await repo.getAllTrustedMints();
        expect(trustedMints.length).toBe(1);
        expect(trustedMints[0]!.mintUrl).toBe(mint.mintUrl);
      });
    });

    describe('getMintByUrl', () => {
      it('should retrieve mint with correct trust status', async () => {
        const mint = createTestMint('https://test.mint', true);
        await repo.addNewMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
      });

      it('should throw when mint does not exist', async () => {
        await expect(repo.getMintByUrl('https://non-existent.mint')).rejects.toThrow();
      });
    });

    describe('updateMint', () => {
      it('should update mint trust status', async () => {
        const mint = createTestMint('https://test.mint', false);
        await repo.addNewMint(mint);

        mint.trusted = true;
        await repo.updateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
      });

      it('should update all mint fields', async () => {
        const mint = createTestMint('https://test.mint', false);
        await repo.addNewMint(mint);

        mint.trusted = true;
        mint.name = 'Updated Name';
        mint.updatedAt = Math.floor(Date.now() / 1000) + 10;
        await repo.updateMint(mint);

        const retrieved = await repo.getMintByUrl(mint.mintUrl);
        expect(retrieved.trusted).toBe(true);
        expect(retrieved.name).toBe('Updated Name');
      });
    });

    describe('deleteMint', () => {
      it('should delete mint completely', async () => {
        const mint = createTestMint('https://test.mint', true);
        await repo.addNewMint(mint);

        await repo.deleteMint(mint.mintUrl);

        const isTrusted = await repo.isTrustedMint(mint.mintUrl);
        expect(isTrusted).toBe(false);

        await expect(repo.getMintByUrl(mint.mintUrl)).rejects.toThrow();
      });

      it('should not affect other mints', async () => {
        const mint1 = createTestMint('https://mint1.test', true);
        const mint2 = createTestMint('https://mint2.test', false);

        await repo.addNewMint(mint1);
        await repo.addNewMint(mint2);

        await repo.deleteMint(mint1.mintUrl);

        const mint2Retrieved = await repo.getMintByUrl(mint2.mintUrl);
        expect(mint2Retrieved.trusted).toBe(false);
      });
    });
  });
}

// Run tests for MemoryMintRepository
testMintRepository('MemoryMintRepository', async () => new MemoryMintRepository());
