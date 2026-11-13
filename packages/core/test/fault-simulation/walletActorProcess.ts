/**
 * Wallet actor process: one real Coco Session with a persistent SQLite store.
 *
 * The parent harness talks to this process with one JSON command per stdin line and receives one
 * JSON reply per stdout line. Every command uses Coco's public interface. Background Watchers and
 * Background Processors keep their defaults. The process is terminated abruptly to simulate a
 * crash; a replacement process opens the same store with the same Wallet Seed.
 *
 * Replies may carry a created token for delivery by the harness. Nothing here logs the Wallet Seed,
 * tokens or proofs.
 */
import { Amount, getEncodedToken } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco } from '../../Manager.ts';
import type { ActorCommand, ActorReply } from './walletActor.ts';

const { SIM_DB_PATH, SIM_SEED_PATH, SIM_MINT_URL, SIM_UNIT } = process.env;
if (!SIM_DB_PATH || !SIM_SEED_PATH || !SIM_MINT_URL || !SIM_UNIT) {
  throw new Error('Wallet actor requires SIM_DB_PATH, SIM_SEED_PATH, SIM_MINT_URL and SIM_UNIT');
}
const mintUrl = SIM_MINT_URL;
const unit = SIM_UNIT;
const seed = Uint8Array.from(Buffer.from(readFileSync(SIM_SEED_PATH, 'utf8').trim(), 'hex'));

const repo = new SqlStorageRepositories({
  database: new SqliteDb({ database: new Database(SIM_DB_PATH, { create: true }) }),
});
await repo.init();
// Session initialization performs Operation Recovery for persisted in-flight operations.
const coco = await initializeCoco({ repo, seedGetter: async () => seed });

async function fund(amount: number) {
  const quote = await coco.quotes.mint.create({
    mintUrl,
    amount: { amount: Amount.from(amount), unit },
    method: 'bolt11',
  });
  const prepared = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount: Amount.from(amount),
  });
  // The fake Lightning backend pays the quote; the operation may still need to observe that.
  let operation = await coco.ops.mint.execute(prepared.id);
  for (let attempt = 0; operation.state !== 'finalized' && attempt < 50; attempt++) {
    await Bun.sleep(100);
    operation = await coco.ops.mint.refresh(prepared.id);
    if (operation.state === 'pending') operation = await coco.ops.mint.execute(prepared.id);
  }
  return { operationId: prepared.id, state: operation.state };
}

async function observe(operationIds: string[]) {
  const balance = await coco.wallet.balances.total({ mintUrls: [mintUrl], units: [unit] });
  const history = await coco.history.getPaginatedHistory(0, 1_000);
  const operations = await Promise.all(
    operationIds.map(async (id) => ({
      id,
      state: (await coco.ops.receive.get(id))?.state,
      historyEntries: history.filter((entry) => entry.operationId === id).length,
    })),
  );
  return { balance: Number(balance.total.toString()), operations };
}

async function handle(command: ActorCommand): Promise<unknown> {
  switch (command.type) {
    case 'addMint':
      await coco.mint.addMint(mintUrl, { trusted: true });
      return {};
    case 'fund':
      return fund(command.amount);
    case 'send': {
      const prepared = await coco.ops.send.prepare({ mintUrl, amount: command.amount, unit });
      const { operation, token } = await coco.ops.send.execute(prepared.id);
      return { operationId: operation.id, token: getEncodedToken(token) };
    }
    case 'prepareReceive':
      return { operationId: (await coco.ops.receive.prepare({ token: command.token })).id };
    case 'executeReceive':
      return { state: (await coco.ops.receive.execute(command.operationId)).state };
    case 'observe':
      return observe(command.operationIds);
    case 'dispose':
      await coco.dispose();
      return {};
  }
}

function reply(message: ActorReply) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

reply({ id: 0, ok: true, result: { ready: true } });
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const { id, command } = JSON.parse(line) as { id: number; command: ActorCommand };
  // Commands run concurrently so observation stays available while a foreground command waits.
  void handle(command).then(
    (result) => {
      reply({ id, ok: true, result });
      if (command.type === 'dispose') process.exit(0);
    },
    (error: unknown) =>
      reply({
        id,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
  );
}
