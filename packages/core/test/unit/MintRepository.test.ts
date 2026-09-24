import { describe, it, beforeEach, expect } from 'bun:test';
import { MemoryMintRepository } from '../../repositories/memory/MemoryMintRepository';
import type { MintRepository } from '../../repositories';
import type { Mint } from '../../models/Mint';

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
    });

    describe('getMintByUrl', () => {
      it('should throw when mint does not exist', async () => {
        await expect(repo.getMintByUrl('https://non-existent.mint')).rejects.toThrow();
      });
    });

    describe('findMintByUrl', () => {
      it('should return null when mint does not exist', async () => {
        expect(await repo.findMintByUrl('https://non-existent.mint')).toBeNull();
      });

      it('should return null after the mint is deleted', async () => {
        const mint = createTestMint('https://test.mint', true);
        await repo.addNewMint(mint);
        await repo.deleteMint(mint.mintUrl);

        expect(await repo.findMintByUrl(mint.mintUrl)).toBeNull();
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
