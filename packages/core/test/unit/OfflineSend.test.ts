import { Amount, deriveKeysetId, sumProofs } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco, type CocoConfig, type Manager } from '../../Manager.ts';
import type { PrepareSendInput } from '../../api/SendOpsApi.ts';
import {
  OfflineSendError,
  ProofValidationError,
  type OfflineSendReason,
} from '../../models/Error.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { testMintInfo, testMintKeypairs, testMintKeysetId } from '../fixtures/MintMetadata.ts';

const mintUrl = 'https://offline-send.test';
const disabledRuntime = {
  requestRateLimit: { disabled: true },
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
    mintSwapOperationProcessor: { disabled: true },
  },
} satisfies Pick<CocoConfig, 'requestRateLimit' | 'watchers' | 'processors'>;

// Stored proofs stand in for earlier issuance. Assertions use the application API.
async function seedWallet(
  repo: Repositories,
  options: { active?: boolean; unit?: string; feePpk?: number } = {},
) {
  const unit = options.unit ?? 'sat';
  const feePpk = options.feePpk ?? 0;
  const id = testMintKeysetId(unit, { input_fee_ppk: feePpk });
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
    feePpk,
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
  const cleanup: (() => void)[] = [];
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    globalThis.fetch = originalFetch;
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

  /** The mint is the system boundary: every request fails, as it does without a network. */
  function blockNetwork() {
    const fetch = mock(async () => {
      throw new Error('network is offline');
    });
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
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
    { input: { amount: 3 }, reason: 'no_exact_match' },
    { input: { amount: 8, forceSwap: true }, reason: 'unsupported_option' },
    { input: { amount: 7, coverReceiverFees: true }, reason: 'unsupported_option' },
    {
      input: { amount: 8, target: { type: 'p2pk', pubkey: testMintKeypairs['1'] } },
      reason: 'unsupported_option',
    },
  ] satisfies { input: Partial<PrepareSendInput>; reason: OfflineSendReason }[])(
    'refuses a send that needs the mint and reserves nothing: %j',
    async ({ input, reason }) => {
      const repo = new MemoryRepositories();
      await seedWallet(repo);
      const fetch = blockNetwork();
      const manager = await start(repo);
      const rejection = await manager.ops.send
        .prepare({ mintUrl, offline: true, ...input })
        .catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(OfflineSendError);
      expect((rejection as OfflineSendError).reason).toBe(reason);
      expect(await manager.ops.send.listPrepared()).toEqual([]);
      expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
      const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
      await manager.ops.send.cancel(prepared.id);
      expect((await manager.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.from(8));
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('reports a balance below the amount as it does online', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    const fetch = blockNetwork();
    const manager = await start(repo);
    const rejection = await manager.ops.send
      .prepare({ mintUrl, amount: 9, offline: true })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(ProofValidationError);
    expect(rejection).not.toBeInstanceOf(OfflineSendError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('prefers the proof the receiver pays least to redeem among equal amounts', async () => {
    const repo = new MemoryRepositories();
    // Three stored 8-unit proofs: keysets charging 1000 ppk and 100 ppk, and one not stored.
    await seedWallet(repo, { feePpk: 1000 });
    const cheaperId = testMintKeysetId('sat', { input_fee_ppk: 100 });
    await repo.keysetRepository.addKeyset({
      mintUrl,
      id: cheaperId,
      unit: 'sat',
      keypairs: testMintKeypairs,
      active: false,
      feePpk: 100,
    });
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        mintUrl,
        id: cheaperId,
        unit: 'sat',
        amount: Amount.from(8),
        secret: 'cheaper-to-redeem',
        C: testMintKeypairs['8'],
        state: 'ready',
      },
      // A proof whose keyset is not stored has no known fee, so it is taken last.
      {
        mintUrl,
        id: '00ffffffffffffff',
        unit: 'sat',
        amount: Amount.from(8),
        secret: 'unknown-keyset',
        C: testMintKeypairs['8'],
        state: 'ready',
      },
    ]);
    blockNetwork();
    const manager = await start(repo);
    const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
    expect(prepared.inputProofSecrets).toEqual(['cheaper-to-redeem']);
  });

  it('sends a stored proof whose keyset is not stored, as an online exact send does', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    await repo.keysetRepository.deleteKeyset(mintUrl, testMintKeysetId());
    const fetch = blockNetwork();
    const manager = await start(repo);
    const prepared = await manager.ops.send.prepare({ mintUrl, amount: 8, offline: true });
    const { token } = await manager.ops.send.execute(prepared);
    expect(token.proofs.map((proof) => proof.secret)).toEqual(['offline-sat']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses without a library error when a stored proof exceeds the safe integer range', async () => {
    const repo = new MemoryRepositories();
    await seedWallet(repo);
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        mintUrl,
        id: testMintKeysetId(),
        unit: 'sat',
        amount: Amount.from('18014398509481984'),
        secret: 'beyond-safe-integers',
        C: testMintKeypairs['8'],
        state: 'ready',
      },
    ]);
    blockNetwork();
    const manager = await start(repo);
    const rejection = await manager.ops.send
      .prepare({ mintUrl, amount: 3, offline: true })
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(OfflineSendError);
    expect((rejection as OfflineSendError).reason).toBe('no_exact_match');
    expect(await manager.ops.send.listPrepared()).toEqual([]);
  });

  it('lets only one of two sessions reserve the same stored proofs', async () => {
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
    expect((await second.wallet.balances.byUnit()).sat?.spendable).toEqual(Amount.zero());
    expect(fetch).not.toHaveBeenCalled();
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

  it('finds an exact binary amount even when randomized selection misses it', async () => {
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
    // Pins the seed at which the randomized selector misses this sum, so a return to it fails.
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
