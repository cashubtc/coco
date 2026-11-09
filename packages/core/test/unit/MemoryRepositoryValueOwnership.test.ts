import { describe, it, expect } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import { MemoryAuthSessionRepository } from '../../repositories/memory/MemoryAuthSessionRepository';
import { MemoryCounterRepository } from '../../repositories/memory/MemoryCounterRepository';
import { MemoryKeyRingRepository } from '../../repositories/memory/MemoryKeyRingRepository';
import { MemoryMeltOperationRepository } from '../../repositories/memory/MemoryMeltOperationRepository';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';
import { MemoryKeysetRepository } from '../../repositories/memory/MemoryKeysetRepository';
import { MemoryMintRepository } from '../../repositories/memory/MemoryMintRepository';
import type { AuthSession } from '../../models/AuthSession';
import type { Keypair } from '../../models/Keypair';
import type { Mint } from '../../models/Mint';
import type { MeltOperation } from '../../operations/melt/MeltOperation';
import type { MintOperation } from '../../operations/mint/MintOperation';

const mintUrl = 'https://mint.test';

// Repository writes must be the only way to change stored records (#473).
describe('memory repositories own their stored values', () => {
  it('counter reads are detached', async () => {
    const repo = new MemoryCounterRepository();
    await repo.setCounter(mintUrl, 'ks', 1);

    const read = await repo.getCounter(mintUrl, 'ks');
    read!.counter = 99;

    expect((await repo.getCounter(mintUrl, 'ks'))!.counter).toBe(1);
  });

  it('auth session writes and reads are detached', async () => {
    const repo = new MemoryAuthSessionRepository();
    const session: AuthSession = {
      mintUrl,
      accessToken: 'a',
      expiresAt: 1,
      batPool: [{ id: 'ks', amount: Amount.from(1), secret: 's', C: 'c' }],
    };
    await repo.saveSession(session);

    session.accessToken = 'changed';
    session.batPool!.push({ id: 'ks', amount: Amount.from(2), secret: 's2', C: 'c2' });
    (await repo.getSession(mintUrl))!.batPool!.pop();
    (await repo.getAllSessions())[0]!.expiresAt = 99;

    const stored = await repo.getSession(mintUrl);
    expect(stored!.accessToken).toBe('a');
    expect(stored!.expiresAt).toBe(1);
    expect(stored!.batPool).toHaveLength(1);
  });

  it('mint writes and reads are detached', async () => {
    const repo = new MemoryMintRepository();
    const mint = {
      mintUrl,
      name: 'Test Mint',
      mintInfo: { name: 'Test Mint', nuts: {}, contact: [] },
      trusted: false,
      createdAt: 1,
      updatedAt: 1,
    } as unknown as Mint;
    await repo.addNewMint(mint);

    mint.name = 'changed';
    (await repo.getMintByUrl(mintUrl)).trusted = true;
    (await repo.findMintByUrl(mintUrl))!.mintInfo.name = 'changed';
    (await repo.getAllMints())[0]!.updatedAt = 99;

    const stored = await repo.getMintByUrl(mintUrl);
    expect(stored.name).toBe('Test Mint');
    expect(stored.trusted).toBe(false);
    expect(stored.mintInfo.name).toBe('Test Mint');
    expect(stored.updatedAt).toBe(1);
    expect(await repo.getAllTrustedMints()).toHaveLength(0);
  });

  it('keyset writes and reads are detached', async () => {
    const repo = new MemoryKeysetRepository();
    const keypairs: Record<string, string> = { '1': 'pub1' };
    await repo.addKeyset({ mintUrl, id: 'ks', unit: 'sat', keypairs, active: true, feePpk: 0 });

    keypairs['2'] = 'pub2';
    (await repo.getKeysetById(mintUrl, 'ks'))!.active = false;
    (await repo.getKeysetsByMintUrl(mintUrl))[0]!.keypairs['1'] = 'evil';

    const stored = await repo.getKeysetById(mintUrl, 'ks');
    expect(stored!.active).toBe(true);
    expect(stored!.keypairs).toEqual({ '1': 'pub1' });
  });

  it('keypair writes and reads are detached', async () => {
    const repo = new MemoryKeyRingRepository();
    const keyPair: Keypair = { publicKeyHex: 'pub', secretKey: new Uint8Array([1, 2, 3]) };
    await repo.setPersistedKeyPair(keyPair);

    keyPair.secretKey[0] = 9;
    (await repo.getPersistedKeyPair('pub'))!.secretKey[1] = 9;
    (await repo.getLatestKeyPair())!.derivationIndex = 7;
    (await repo.getAllPersistedKeyPairs())[0]!.secretKey[2] = 9;

    const stored = await repo.getPersistedKeyPair('pub');
    expect(Array.from(stored!.secretKey)).toEqual([1, 2, 3]);
    expect(stored!.derivationIndex).toBeUndefined();
  });

  it('melt and mint operation writes and reads keep nested data detached', async () => {
    const melt = new MemoryMeltOperationRepository();
    const mint = new MemoryMintOperationRepository();
    for (const repo of [melt, mint] as const) {
      const operation = {
        id: 'op',
        mintUrl,
        quoteId: 'q',
        state: 'init',
        createdAt: 1,
        updatedAt: 1,
        nested: { secrets: ['a'] },
      } as unknown as MeltOperation & MintOperation;
      await repo.create(operation);

      (operation as unknown as { nested: { secrets: string[] } }).nested.secrets.push('b');
      const read = (await repo.getById('op')) as unknown as { nested: { secrets: string[] } };
      read.nested.secrets.push('c');

      const stored = (await repo.getById('op')) as unknown as { nested: { secrets: string[] } };
      expect(stored.nested.secrets).toEqual(['a']);
    }
  });
});
