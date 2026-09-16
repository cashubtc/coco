/// <reference types="bun" />

import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Mint } from '@cashu/coco-core/adapter';
import { ensureSchemaUpTo } from '../index.ts';
import { SqliteMintRepository } from '../repositories/MintRepository.ts';
import { createBunSqlDatabase } from './bunSqlDatabase.ts';

function createDummyMint(mintUrl: string): Mint {
  return {
    mintUrl,
    name: `Test Mint ${mintUrl}`,
    mintInfo: {
      name: `Test Mint ${mintUrl}`,
      pubkey: 'pubkey',
      version: '1.0',
      contact: {},
      nuts: {},
    } as Mint['mintInfo'],
    trusted: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

async function createRepository(): Promise<SqliteMintRepository> {
  const database = new Database(':memory:');
  const db = createBunSqlDatabase(database);
  await ensureSchemaUpTo(db);
  return new SqliteMintRepository(db);
}

describe('SqliteMintRepository', () => {
  describe('getMintByUrl', () => {
    it('returns the mint when it exists', async () => {
      const repository = await createRepository();
      const mint = createDummyMint('https://found.mint');
      await repository.addNewMint(mint);

      const retrieved = await repository.getMintByUrl(mint.mintUrl);
      expect(retrieved.mintUrl).toBe(mint.mintUrl);
    });

    it('throws when the mint does not exist', async () => {
      const repository = await createRepository();

      await expect(repository.getMintByUrl('https://missing.mint')).rejects.toThrow();
    });
  });

  describe('findMintByUrl', () => {
    it('returns the mint when it exists', async () => {
      const repository = await createRepository();
      const mint = createDummyMint('https://found.mint');
      await repository.addNewMint(mint);

      const retrieved = await repository.findMintByUrl(mint.mintUrl);
      expect(retrieved?.mintUrl).toBe(mint.mintUrl);
    });

    it('returns null when the mint does not exist', async () => {
      const repository = await createRepository();

      expect(await repository.findMintByUrl('https://missing.mint')).toBeNull();
    });

    it('returns null after the mint is deleted', async () => {
      const repository = await createRepository();
      const mint = createDummyMint('https://deleted.mint');
      await repository.addNewMint(mint);
      await repository.deleteMint(mint.mintUrl);

      expect(await repository.findMintByUrl(mint.mintUrl)).toBeNull();
    });

    it('propagates a genuine storage read failure instead of returning null', async () => {
      const database = new Database(':memory:');
      const db = createBunSqlDatabase(database);
      await ensureSchemaUpTo(db);
      const repository = new SqliteMintRepository(db);
      const mint = createDummyMint('https://unreadable.mint');
      await repository.addNewMint(mint);

      await db.exec('DROP TABLE coco_cashu_mints');

      await expect(repository.findMintByUrl(mint.mintUrl)).rejects.toThrow(/no such table/i);
    });
  });
});
