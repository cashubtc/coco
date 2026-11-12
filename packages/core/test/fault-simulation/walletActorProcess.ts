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

const { SIM_DB_PATH, SIM_SEED_PATH, SIM_MINT_URLS, SIM_UNIT, SIM_PROXY_URL, SIM_RECOVERY_MODE } =
  process.env;
if (!SIM_DB_PATH || !SIM_SEED_PATH || !SIM_MINT_URLS || !SIM_UNIT || !SIM_PROXY_URL) {
  throw new Error(
    'Wallet actor requires SIM_DB_PATH, SIM_SEED_PATH, SIM_MINT_URLS, SIM_UNIT and SIM_PROXY_URL',
  );
}
const mintUrls = JSON.parse(SIM_MINT_URLS) as string[];
const unit = SIM_UNIT;
const seed = Uint8Array.from(Buffer.from(readFileSync(SIM_SEED_PATH, 'utf8').trim(), 'hex'));

const repo = new SqlStorageRepositories({
  database: new SqliteDb({ database: new Database(SIM_DB_PATH, { create: true }) }),
});
await repo.init();
// Session initialization performs Operation Recovery for persisted in-flight operations.
// HTTP reaches the transport link through HTTP_PROXY. Bun's WebSocket ignores that variable, so
// the documented factory option routes WebSockets through the same link.
const coco = await initializeCoco({
  repo,
  seedGetter: async () => seed,
  webSocketFactory: (url) => new WebSocket(url, { proxy: SIM_PROXY_URL } as never),
});

async function fund(mintUrl: string, amount: number) {
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

async function observe(receiveIds: string[], sendIds: string[]) {
  const balances: Record<string, number> = {};
  for (const mintUrl of mintUrls) {
    const balance = await coco.wallet.balances.total({ mintUrls: [mintUrl], units: [unit] });
    balances[mintUrl] = Number(balance.total.toString());
  }
  const history = await coco.history.getPaginatedHistory(0, 10_000);
  const entries = (id: string) => history.filter((entry) => entry.operationId === id).length;
  const operations = [
    ...(await Promise.all(
      receiveIds.map(async (id) => ({
        id,
        kind: 'receive' as const,
        state: (await coco.ops.receive.get(id))?.state,
        historyEntries: entries(id),
      })),
    )),
    ...(await Promise.all(
      sendIds.map(async (id) => ({
        id,
        kind: 'send' as const,
        state: (await coco.ops.send.get(id))?.state,
        historyEntries: entries(id),
      })),
    )),
  ];
  return { balances, operations };
}

async function handle(command: ActorCommand): Promise<unknown> {
  switch (command.type) {
    case 'addMints':
      for (const mintUrl of mintUrls) await coco.mint.addMint(mintUrl, { trusted: true });
      return {};
    case 'fund':
      return fund(command.mintUrl, command.amount);
    case 'prepareSend': {
      const prepared = await coco.ops.send.prepare({
        mintUrl: command.mintUrl,
        amount: command.amount,
        unit,
      });
      return { operationId: prepared.id };
    }
    case 'executeSend': {
      const { token } = await coco.ops.send.execute(command.operationId);
      return { token: getEncodedToken(token) };
    }
    case 'sendToken': {
      const operation = await coco.ops.send.get(command.operationId);
      const token = operation && 'token' in operation ? operation.token : undefined;
      return { state: operation?.state, ...(token ? { token: getEncodedToken(token) } : {}) };
    }
    case 'prepareReceive':
      return { operationId: (await coco.ops.receive.prepare({ token: command.token })).id };
    case 'executeReceive':
      return { state: (await coco.ops.receive.execute(command.operationId)).state };
    case 'reclaim':
      await coco.ops.send.reclaim(command.operationId);
      return { state: (await coco.ops.send.get(command.operationId))?.state };
    case 'observe':
      return observe(command.receiveIds, command.sendIds);
    case 'recover':
      // Defence in depth: an automatic-progress scenario must never be rescued by this call.
      if (SIM_RECOVERY_MODE !== 'explicit') {
        throw new Error('Explicit recovery is not permitted in an automatic-recovery scenario');
      }
      await coco.ensureSubscriptions();
      await coco.ops.send.recovery.run();
      await coco.ops.receive.recovery.run();
      return {};
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
