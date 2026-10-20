import { describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { initializeCoco, Manager } from '@cashu/coco-core';
import { createIndexedDbStorage } from '../index.ts';

describe('IndexedDB storage lifecycle', () => {
  it('opens during init and preserves Wallet data across close and a new handle', async () => {
    const name = `storage-${crypto.randomUUID()}`;
    const seedGetter = async () => new Uint8Array(64).fill(7);
    const storage = createIndexedDbStorage({ name });
    let next: ReturnType<typeof createIndexedDbStorage> | undefined;
    try {
      await storage.init();
      // Database existence proves initialization opened the connection rather than registering schema only.
      expect(await Dexie.exists(name)).toBe(true);
      const first = new Manager(storage, seedGetter);
      const keypair = await first.keyring.generateKeyPair(true);
      await first.dispose();
      storage.close();
      next = createIndexedDbStorage({ name });
      await next.init();
      const second = new Manager(next, seedGetter);
      expect(await second.keyring.getKeyPair(keypair.publicKeyHex)).toEqual(keypair);
      const generated = await second.keyring.generateKeyPair(true);
      expect(generated.publicKeyHex).not.toBe(keypair.publicKeyHex);
      await second.dispose();
    } finally {
      storage.close();
      next?.close();
      await Dexie.delete(name);
    }
  });

  it('reports opening failure from init and canonical startup', async () => {
    const name = `storage-incompatible-${crypto.randomUUID()}`;
    const newer = new Dexie(name);
    newer.version(1).stores({ coco_cashu_mints: '&wrongPrimaryKey' });
    await newer.open();
    newer.close();
    const storage = createIndexedDbStorage({ name });
    try {
      await expect(storage.init()).rejects.toThrow();
      await expect(
        initializeCoco({ storage, seedGetter: async () => new Uint8Array(64) }),
      ).rejects.toThrow();
    } finally {
      storage.close();
      await Dexie.delete(name);
    }
  });
});
