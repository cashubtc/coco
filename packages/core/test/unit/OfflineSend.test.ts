import { Amount, deriveKeysetId, sumProofs } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco, type CocoConfig, type Manager } from '../../Manager.ts';
import type { PrepareSendInput } from '../../api/SendOpsApi.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://offline-send.test';
const disabledRuntime = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
} satisfies Pick<CocoConfig, 'watchers' | 'processors'>;

// Stored proofs stand in for earlier issuance. Assertions use the application API.
async function seedWallet(repo: Repositories, options: { active?: boolean; unit?: string } = {}) {
  const unit = options.unit ?? 'sat';
  const id = testMintKeysetId(unit);
  await repo.init();
  await repo.mintRepository.addNewMint({
    mintUrl,
    name: 'Offline send mint',
    trusted: true,
    mintInfo: testMintInfo,
    createdAt: 1,
    updatedAt: 1,
  });
  await repo.keysetRepository.addKeyset({
    mintUrl,
    id,
    unit,
    keypairs: testMintKeypairs,
    active: options.active ?? true,
    feePpk: 0,
  });
  await repo.proofRepository.saveProofs(mintUrl, [
    {
      mintUrl,
      id,
      unit,
      amount: Amount.from(8),
      secret: `offline-${unit}`,
      C: testMintKeypairs['8'],
      state: 'ready',
    },
  ]);
}

describe('offline sends through the public API', () => {
  const managers: Manager[] = [];
  const fetchSpies: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>[] = [];
  const cleanup: (() => void)[] = [];

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const spy of fetchSpies.splice(0)) spy.mockRestore();
    for (const work of cleanup.splice(0).reverse()) work();
  });

  async function start(repo: Repositories) {
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64),
      ...disabledRuntime,
    });
    managers.push(manager);
    return manager;
  }

  function blockNetwork() {
    const fetch = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network is offline'));
    fetchSpies.push(fetch);
    return fetch;
  }

  it.each(['memory', 'sqlite'] as const)(
    'prepares and executes from stale stored metadata after restarting offline (%s)',
    async (adapter) => {
      let repo: Repositories;
      let database: Database | undefined;
      let filename: string | undefined;
      if (adapter === 'sqlite') {
        const directory = mkdtempSync(join(tmpdir(), 'coco-offline-'));
        cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
        filename = join(directory, 'wallet.sqlite');
        database = new Database(filename);
        cleanup.push(() => database?.close());
        repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      } else {
        repo = new MemoryRepositories();
      }
      await seedWallet(repo);
      const first = await start(repo);
      await first.dispose();
      if (filename && database) {
        database.close();
        database = new Database(filename);
        repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      }
      const fetch = blockNetwork();
      const manager = await start(repo);
      expect(fetch).not.toHaveBeenCalled();
      const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
      expect(prepared.needsSwap).toBe(false);
      expect(prepared.fee).toEqual(Amount.zero());
      await manager.dispose();
      const resumed = await start(repo);
      const result = await resumed.ops.send.execute(prepared.id);
      expect(result.operation.state).toBe('pending');
      expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['offline-sat']);
      expect(result.token.proofs[0]!.amount).toEqual(Amount.from(8));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('sends inactive-keyset proofs without creating outputs or mixing units', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo, { active: false });
    await seedWallet(repo, { active: false, unit: 'usd' });
    const fetch = blockNetwork();
    const manager = await start(repo);
    const prepared = await manager.ops.send.prepare({
      mintUrl,
      amount: 8,
      unit: 'usd',
      offline: true,
    });
    expect(prepared.outputData).toBeUndefined();
    const result = await manager.ops.send.execute(prepared);
    expect(result.token.unit).toBe('usd');
    expect(result.token.proofs.map((proof) => proof.secret)).toEqual(['offline-usd']);
    expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { amount: 3 },
    { amount: 8, forceSwap: true },
    { amount: 8, target: { type: 'p2pk', pubkey: testMintKeypairs['1'] } },
  ] satisfies Partial<PrepareSendInput>[])(
    'rejects mint-dependent sends atomically: %j',
    async (input) => {
      const repo = new MemoryRepositories();
      await seedWallet(repo);
      const fetch = blockNetwork();
      const manager = await start(repo);
      await expect(manager.ops.send.prepare({ mintUrl, offline: true, ...input })).rejects.toThrow(
        'Offline send',
      );
      expect(await manager.ops.send.listPrepared()).toEqual([]);
      expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
      const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
      await manager.ops.send.cancel(prepared.id);
      expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('fails locally when the stored keyset is missing', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    await repo.keysetRepository.deleteKeyset(mintUrl, testMintKeysetId());
    const fetch = blockNetwork();
    const manager = await start(repo);
    await expect(manager.ops.send.prepare({ mintUrl, amount: 8, offline: true })).rejects.toThrow();
    expect(await manager.ops.send.listPrepared()).toEqual([]);
    expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps reservations exclusive across sessions and never releases an exposed token offline', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    const fetch = blockNetwork();
    const first = await start(repo);
    const second = await start(repo);
    const attempts = await Promise.allSettled([
      first.ops.send.prepare({ mintUrl, amount: 8, offline: true }),
      second.ops.send.prepare({ mintUrl, amount: 8, offline: true }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    const [prepared] = await first.ops.send.listPrepared();
    expect((await second.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.zero());
    await second.ops.send.cancel(prepared!.id);
    const retry = await second.ops.send.prepare({ mintUrl, amount: 8, offline: true });
    await first.ops.send.execute(retry.id);
    expect(fetch).not.toHaveBeenCalled();
    await expect(second.ops.send.reclaim(retry.id)).rejects.toThrow();
    expect((await first.wallet.balances.total({ units: ['sat'] })).spendable).toEqual(
      Amount.zero(),
    );
    expect((await first.ops.send.get(retry.id))?.state).toBe('pending');
  });

  it('does not suppress metadata refresh for subsequent online sends', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    const fetch = blockNetwork();
    const manager = await start(repo);
    const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
    await manager.ops.send.cancel(prepared.id);
    expect(fetch).not.toHaveBeenCalled();
    await expect(manager.ops.send.prepare({ mintUrl, amount: 8 })).rejects.toThrow(
      'Failed to fetch mint',
    );
    expect(fetch).toHaveBeenCalled();
    expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
  });

  it("finds Sovran's exact binary amount even when randomized selection misses it", async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    await repo.proofRepository.deleteProofs(mintUrl, ['offline-sat']);
    const amounts = [512, 1, 32, 32, 8, 1, 4, 1, 256, 4, 8, 512];
    const keypairs = Object.fromEntries(amounts.map((amount) => [amount, testMintKeypairs['1']]));
    const id = deriveKeysetId(keypairs, { unit: 'sat' });
    await repo.keysetRepository.addKeyset({
      mintUrl,
      id,
      unit: 'sat',
      keypairs,
      active: true,
      feePpk: 0,
    });
    await repo.proofRepository.saveProofs(
      mintUrl,
      amounts.map((amount, index) => ({
        mintUrl,
        id,
        unit: 'sat',
        amount: Amount.from(amount),
        secret: `selection-${index}`,
        C: testMintKeypairs['1'],
        state: 'ready' as const,
      })),
    );
    const fetch = blockNetwork();
    const manager = await start(repo);
    const random = spyOn(Math, 'random').mockReturnValue(0);
    try {
      const prepared = await manager.ops.send.prepare({ mintUrl, amount: 1097, offline: true });
      const { token } = await manager.ops.send.execute(prepared);
      expect(sumProofs(token.proofs)).toEqual(Amount.from(1097));
      expect(new Set(token.proofs.map((proof) => proof.secret)).size).toBe(token.proofs.length);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});
