/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { IdbMintRepository } from './MintRepository.ts';
import type { MintRow } from '../lib/db.ts';

function createFakeDb() {
  const rows = new Map<string, MintRow>();
  return {
    rows,
    table: () => ({
      get: async (mintUrl: string) => rows.get(mintUrl),
      put: async (row: MintRow) => {
        rows.set(row.mintUrl, row);
      },
      delete: async (mintUrl: string) => {
        rows.delete(mintUrl);
      },
      toArray: async () => Array.from(rows.values()),
    }),
  };
}

function createDummyMintRow(mintUrl: string): MintRow {
  return {
    mintUrl,
    name: `Test Mint ${mintUrl}`,
    mintInfo: JSON.stringify({ name: `Test Mint ${mintUrl}`, pubkey: 'pubkey', version: '1.0' }),
    trusted: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('IdbMintRepository', () => {
  describe('getMintByUrl', () => {
    it('returns the mint when it exists', async () => {
      const db = createFakeDb();
      db.rows.set('https://found.mint', createDummyMintRow('https://found.mint'));
      const repository = new IdbMintRepository(db as any);

      const retrieved = await repository.getMintByUrl('https://found.mint');
      expect(retrieved.mintUrl).toBe('https://found.mint');
    });

    it('throws when the mint does not exist', async () => {
      const repository = new IdbMintRepository(createFakeDb() as any);

      await expect(repository.getMintByUrl('https://missing.mint')).rejects.toThrow();
    });
  });

  describe('findMintByUrl', () => {
    it('returns the mint when it exists', async () => {
      const db = createFakeDb();
      db.rows.set('https://found.mint', createDummyMintRow('https://found.mint'));
      const repository = new IdbMintRepository(db as any);

      const retrieved = await repository.findMintByUrl('https://found.mint');
      expect(retrieved?.mintUrl).toBe('https://found.mint');
    });

    it('returns null when the mint does not exist', async () => {
      const repository = new IdbMintRepository(createFakeDb() as any);

      expect(await repository.findMintByUrl('https://missing.mint')).toBeNull();
    });

    it('returns null after the mint is deleted', async () => {
      const db = createFakeDb();
      const repository = new IdbMintRepository(db as any);
      const mint = createDummyMintRow('https://deleted.mint');
      db.rows.set(mint.mintUrl, mint);

      await repository.deleteMint(mint.mintUrl);

      expect(await repository.findMintByUrl(mint.mintUrl)).toBeNull();
    });
  });
});
