import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { mnemonicToSeedSync } from '@scure/bip39';
import { NPCPlugin } from 'coco-cashu-plugin-npc';
import { finalizeEvent, nip19 } from 'nostr-tools';
import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeNpc } from '../test/helpers/fake-npc.js';
import { startTcpTestServer } from '../test/helpers/tcp.js';
import { AdministrativeCredential, loadClientCredential } from './credentials.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from './routes.js';
import { CocodRuntime } from './runtime.js';
import type { AppLogger } from './utils/logger.js';
import { buildV1FallbackHandler, buildV1Routes, createV1RouteDefinitions } from './v1/http.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-npc-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const npc = startFakeNpc();
  cleanups.push(() => npc.stop());
  const databases: Database[] = [];
  cleanups.push(async () => {
    for (const database of databases) database.close();
  });
  const runtime = await CocodRuntime.load({
    configFile: join(directory, 'state', 'config.json'),
    saltFile: join(directory, 'state', 'salt'),
    initializeSession: async (config) => {
      const database = new Database(join(directory, 'wallet.sqlite'));
      databases.push(database);
      const plugin = new NPCPlugin({ defaultBaseUrl: npc.url });
      const manager = await initializeCoco({
        repo: new SqliteRepositories({ database }),
        seedGetter: async () => mnemonicToSeedSync(config.mnemonic),
        plugins: [plugin],
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
      });
      try {
        const secretKey = privateKeyFromSeedWords(config.mnemonic);
        const npcAccount = await plugin.addAccount({
          id: 'default',
          signer: async (event) => finalizeEvent(event, secretKey),
          autoStart: false,
          useWebsocket: false,
        });
        return { manager, npcAccount, mintUrl: config.mintUrl };
      } catch (error) {
        await manager.dispose();
        throw error;
      }
    },
  });
  cleanups.push(() => runtime.dispose());
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const credential = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  const entries: unknown[] = [];
  const record = (message: string, ...meta: unknown[]) => entries.push([message, ...meta]);
  const logger: AppLogger = {
    child: (context) => {
      entries.push(context);
      return logger;
    },
    debug: record,
    error: record,
    info: record,
    warn: record,
    log: (_level, message, ...meta) => record(message, ...meta),
    flush: async () => {},
  };
  let acceptingWork = true;
  const availability = { isAcceptingWork: () => acceptingWork };
  const server = startTcpTestServer({
    routes: {
      ...buildRoutes(createRouteHandlers(runtime), runtime, credentials, logger, availability),
      ...buildV1Routes(
        createV1RouteDefinitions(runtime, 'test', {
          request: () => Promise.reject(new Error('unexpected process shutdown')),
        }),
        credentials,
        logger,
        availability,
      ),
    },
    fetch: buildV1FallbackHandler(
      credentials,
      buildFallbackHandler(runtime, credentials, logger, availability),
    ),
  });
  cleanups.push(() => server.stop(true));
  const call = (
    path: string,
    options: { method?: string; body?: unknown; credential?: string | null } = {},
  ) =>
    fetch(new URL(path, server.url), {
      method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(options.credential === null
          ? {}
          : { Authorization: `Bearer ${options.credential ?? credential}` }),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  return {
    runtime,
    npc,
    call,
    entries,
    credential,
    stopAdmission: () => {
      acceptingWork = false;
    },
    start: async () => {
      const response = await call('/v1/admin/wallet/initialize', { body: {} });
      expect(response.status).toBe(202);
      await response.json();
      await runtime.startSession().completion;
    },
    setCapabilities: async (capabilities: string[]) => {
      const verifierFile = join(credentialDirectory, 'current', 'verifier.json');
      const state = JSON.parse(await readFile(verifierFile, 'utf8'));
      const temporary = join(credentialDirectory, 'current', 'verifier.next');
      await writeFile(temporary, JSON.stringify({ ...state, capabilities }), { mode: 0o600 });
      await rename(temporary, verifierFile);
    },
  };
}

describe('retained NPC routes over TCP', () => {
  test('removes every superseded Wallet and lifecycle path while retaining v1 and public health', async () => {
    const h = await startHarness();
    expect(Object.keys(createRouteHandlers(h.runtime)).toSorted()).toEqual([
      '/npc/address',
      '/npc/username',
    ]);
    const retired = [
      ['GET', '/balance'],
      ['POST', '/receive/cashu'],
      ['POST', '/receive/bolt11'],
      ['POST', '/send/cashu'],
      ['POST', '/send/bolt11'],
      ['POST', '/x-cashu/parse'],
      ['POST', '/x-cashu/handle'],
      ['POST', '/mints/add'],
      ['GET', '/mints/list'],
      ['POST', '/mints/info'],
      ['GET', '/history'],
      ['GET', '/events'],
      ['GET', '/ping'],
      ['GET', '/status'],
      ['POST', '/init'],
      ['POST', '/unlock'],
      ['POST', '/stop'],
    ] as const;
    for (const running of [false, true]) {
      if (running) await h.start();
      for (const [method, path] of retired) {
        const missingAuth = await h.call(path, { method, credential: null });
        expect(missingAuth.status).toBe(401);
        expect(await missingAuth.json()).toEqual({ error: 'Unauthorized' });
        const removed = await h.call(path, { method });
        expect(removed.status).toBe(404);
        expect(await removed.json()).toEqual({ error: `Unknown endpoint: ${removed.url}` });
      }
    }
    const health = await h.call('/health', { credential: null });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', interfaceVersion: '1' });
    const balance = await h.call('/v1/balances');
    expect(balance.status).toBe(200);
    expect(await balance.json()).toEqual({ items: [] });
    const openapi = await h.call('/v1/openapi.json');
    expect(openapi.status).toBe(200);
    const document = (await openapi.json()) as { paths: object; components: { schemas: object } };
    expect(Object.keys(document.paths)).toHaveLength(57);
    expect(Object.keys(document.components.schemas)).toHaveLength(47);
  });

  test('requires bearer authentication for both NPC routes before session admission', async () => {
    const h = await startHarness();
    for (const credential of [null, 'z'.repeat(43)]) {
      for (const path of ['/npc/address', '/npc/username']) {
        const response = await h.call(path, {
          credential,
          ...(path.endsWith('username') ? { body: {} } : {}),
        });
        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe('Bearer');
        expect(await response.json()).toEqual({ error: 'Unauthorized' });
      }
    }
    const uninitialized = await h.call('/npc/address');
    expect(uninitialized.status).toBe(503);
    expect(await uninitialized.json()).toEqual({
      error: "Wallet not initialized. Run 'cocod wallet initialize' first.",
    });
    expect(h.npc.usernames).toEqual([]);
  });

  test('keeps address fallback, username success, validation, and upstream errors', async () => {
    const h = await startHarness();
    await h.start();
    const unnamed = await h.call('/npc/address');
    expect(unnamed.status).toBe(200);
    const { output } = (await unnamed.json()) as { output: string };
    expect(output).toEndWith('@npubx.cash');
    expect(nip19.decode(output.split('@')[0]!).type).toBe('npub');
    const invalid = await h.call('/npc/username', { body: {} });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Username is required' });
    expect(h.npc.usernames).toEqual([]);
    for (const confirm of [false, true]) {
      const set = await h.call('/npc/username', { body: { username: 'satoshi', confirm } });
      expect(set.status).toBe(200);
      expect(await set.json()).toEqual({ output: { success: true } });
    }
    expect(h.npc.usernames).toEqual(['satoshi', 'satoshi']);
    expect(await (await h.call('/npc/address')).json()).toEqual({ output: 'satoshi@npubx.cash' });
    const unavailable = await h.call('/npc/username', { body: { username: 'unavailable' } });
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).toEqual({
      error: 'Username operation failed: Username unavailable',
    });
    h.npc.failInfo();
    const failed = await h.call('/npc/address');
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Failed to get address: NPC unavailable' });
  });

  test('preserves username payment-required and confirmed insufficient-funds envelopes', async () => {
    const h = await startHarness();
    await h.start();
    const unpaid = await h.call('/npc/username', { body: { username: 'paid-name' } });
    expect(unpaid.status).toBe(402);
    expect(await unpaid.json()).toEqual({
      error:
        "Payment required to set username: 21 SATS. Use 'cocod npc username paid-name --confirm' to proceed",
    });
    const confirmed = await h.call('/npc/username', {
      body: { username: 'paid-name', confirm: true },
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({
      error:
        'Failed to set username. Required amount: 21. Required mints: https://mint.example.com',
    });
    expect(h.npc.usernames).toEqual(['paid-name', 'paid-name']);
  });

  test('enforces read and admin capabilities before invoking the NPC service', async () => {
    const h = await startHarness();
    await h.start();
    await h.setCapabilities(['wallet:read']);
    const address = await h.call('/npc/address');
    expect(address.status).toBe(200);
    await address.json();
    const forbidden = await h.call('/npc/username', { body: { username: 'satoshi' } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Forbidden' });
    expect(h.npc.usernames).toEqual([]);
    await h.setCapabilities(['wallet:admin']);
    const unreadable = await h.call('/npc/address');
    expect(unreadable.status).toBe(403);
    expect(await unreadable.json()).toEqual({ error: 'Forbidden' });
    const allowed = await h.call('/npc/username', { body: { username: 'satoshi' } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ output: { success: true } });
  });

  test('does not include bearer credentials or authorization headers in route logs', async () => {
    const h = await startHarness();
    await h.start();
    const rejectedCredential = 'z'.repeat(43);
    const rejected = await h.call('/npc/address', { credential: rejectedCredential });
    expect(rejected.status).toBe(401);
    await rejected.json();
    const accepted = await h.call('/npc/address');
    expect(accepted.status).toBe(200);
    await accepted.json();
    const logged = JSON.stringify(h.entries);
    expect(logged).toContain('request.rejected');
    expect(logged).toContain('request.completed');
    expect(logged).not.toContain(h.credential);
    expect(logged).not.toContain(rejectedCredential);
    expect(logged.toLowerCase()).not.toContain('authorization');
  });

  test('rejects NPC work after session stop and during process shutdown', async () => {
    const h = await startHarness();
    await h.start();
    await h.runtime.stopSession();
    const stopped = await h.call('/npc/address');
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toEqual({ error: 'Wallet session is stopped' });
    h.stopAdmission();
    for (const path of ['/npc/address', '/npc/username']) {
      const response = await h.call(
        path,
        path.endsWith('username') ? { body: { username: 'satoshi' } } : {},
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Daemon is shutting down' });
    }
    expect(h.npc.usernames).toEqual([]);
  });
});
