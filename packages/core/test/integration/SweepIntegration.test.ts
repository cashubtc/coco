import { Amount } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import type { Repositories } from '../../repositories/index.ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
// scripts/test-integration.sh uses 100ppk normally and zero fees with --custom-unit.
const expectedFee = Amount.from(process.env.CUSTOM_UNIT ? 0 : 1);
const expectedReceived = Amount.from(process.env.CUSTOM_UNIT ? 64 : 63);
const sessions: Manager[] = [];
const config = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
};

async function session(seed: Uint8Array, repo: Repositories = new MemoryRepositories()) {
  await repo.init();
  const coco = await initializeCoco({ repo, seedGetter: async () => seed, ...config });
  sessions.push(coco);
  return coco;
}

async function fund(coco: Manager, unit = 'sat') {
  await coco.mint.addMint(mintUrl, { trusted: true });
  const quote = await coco.quotes.mint.create({
    mintUrl,
    amount: { amount: Amount.from(64), unit },
    method: 'bolt11',
  });
  const operation = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount: Amount.from(64),
  });
  let result = await coco.ops.mint.execute(operation.id);
  for (let attempt = 0; result.state !== 'finalized' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await coco.ops.mint.refresh(operation.id);
    if (result.state === 'pending') result = await coco.ops.mint.execute(operation.id);
  }
  expect(result.state).toBe('finalized');
}

afterEach(async () => {
  for (const coco of sessions.splice(0)) await coco.dispose();
});

describe('wallet.sweep with real Receive and storage', () => {
  it('transfers source value through an ordinary Receive with fees and history', async () => {
    const sourceSeed = crypto.getRandomValues(new Uint8Array(64));
    const source = await session(sourceSeed);
    const destination = await session(crypto.getRandomValues(new Uint8Array(64)));
    await fund(source);

    const report = await destination.wallet.sweep(mintUrl, sourceSeed, { units: ['sat'] });
    const transferred = report.keysets.find((result) => result.status === 'transferred');
    expect(transferred).toMatchObject({
      unit: 'sat',
      received: expectedReceived,
      fee: expectedFee,
    });
    expect(transferred?.receiveOperationId).toBeString();
    const operation = await destination.ops.receive.get(transferred!.receiveOperationId);
    expect(operation?.state).toBe('finalized');
    expect((await destination.wallet.balances.total()).total).toEqual(expectedReceived);
    expect(await destination.history.getPaginatedHistory()).toContainEqual(
      expect.objectContaining({
        type: 'receive',
        operationId: transferred!.receiveOperationId,
      }),
    );

    const repeated = await destination.wallet.sweep(mintUrl, sourceSeed, { units: ['sat'] });
    expect(repeated.keysets.every((result) => result.status === 'noop')).toBe(true);
    expect((await destination.wallet.balances.total()).total).toEqual(expectedReceived);
  }, 30000);
  it('recovers an accepted exchange after reopening persistent Wallet storage without duplicate credit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'coco-sweep-'));
    const filename = join(directory, 'wallet.sqlite');
    let database: Database | undefined;
    let destination: Manager | undefined;
    try {
      const sourceSeed = crypto.getRandomValues(new Uint8Array(64));
      const destinationSeed = crypto.getRandomValues(new Uint8Array(64));
      const source = await session(sourceSeed);
      await fund(source);
      database = new Database(filename);
      const repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
      destination = await session(destinationSeed, repo);
      // Fail only local proof persistence, after the real mint has signed the
      // destination outputs. The durable Receive and its output plan stay real.
      database.exec(
        "CREATE TRIGGER interrupt_sweep BEFORE INSERT ON coco_cashu_proofs BEGIN SELECT RAISE(ABORT, 'settlement interrupted'); END",
      );
      const report = await destination.wallet.sweep(mintUrl, sourceSeed, { units: ['sat'] });
      const unresolved = report.keysets.find((result) => result.status === 'unresolved');
      expect(unresolved?.receiveOperationId).toBeString();
      const operationId = unresolved!.receiveOperationId;
      expect((await destination.ops.receive.get(operationId))?.state).toBe('executing');
      expect((await destination.wallet.balances.total()).total).toEqual(Amount.zero());
      await destination.dispose();
      sessions.splice(sessions.indexOf(destination), 1);
      destination = undefined;
      database.close();

      database = new Database(filename);
      database.exec('DROP TRIGGER interrupt_sweep');
      destination = await session(
        destinationSeed,
        new SqlStorageRepositories({ database: new SqliteDb({ database }) }),
      );
      expect((await destination.ops.receive.get(operationId))?.state).toBe('finalized');
      expect((await destination.wallet.balances.total()).total).toEqual(expectedReceived);
      await destination.ops.receive.recovery.run();
      expect((await destination.wallet.balances.total()).total).toEqual(expectedReceived);
      const history = await destination.history.getPaginatedHistory();
      expect(history.filter((entry) => entry.operationId === operationId)).toHaveLength(1);
    } finally {
      if (destination) {
        await destination.dispose();
        sessions.splice(sessions.indexOf(destination), 1);
      }
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);

  it.skipIf(!process.env.CUSTOM_UNIT)(
    'keeps custom units separate and honors the unit filter',
    async () => {
      const customUnit = process.env.CUSTOM_UNIT!;
      const sourceSeed = crypto.getRandomValues(new Uint8Array(64));
      const source = await session(sourceSeed);
      const destination = await session(crypto.getRandomValues(new Uint8Array(64)));
      await fund(source, 'sat');
      await fund(source, customUnit);

      const filtered = await destination.wallet.sweep(mintUrl, sourceSeed, {
        units: [customUnit.toUpperCase()],
      });
      expect(filtered.keysets.length).toBeGreaterThan(0);
      expect(filtered.keysets.every((result) => result.unit === customUnit)).toBe(true);
      expect((await destination.wallet.balances.byUnit())[customUnit]?.total).toEqual(
        Amount.from(64),
      );
      expect((await destination.wallet.balances.byUnit()).sat?.total ?? Amount.zero()).toEqual(
        Amount.zero(),
      );

      const report = await destination.wallet.sweep(mintUrl, sourceSeed);
      expect(report.keysets).toContainEqual(
        expect.objectContaining({ unit: 'sat', status: 'transferred', received: Amount.from(64) }),
      );
      expect(report.keysets).toContainEqual(
        expect.objectContaining({ unit: customUnit, status: 'noop' }),
      );
      const balances = await destination.wallet.balances.byUnit();
      expect(balances.sat?.total).toEqual(Amount.from(64));
      expect(balances[customUnit]?.total).toEqual(Amount.from(64));
    },
    60000,
  );
});
