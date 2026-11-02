import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeCoco } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';
import { mnemonicToSeedSync } from '@scure/bip39';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV1Client, requestBolt11Receive, watchHistory } from '../../src/cli-shared.js';
import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import { CocodRuntime, type RunningCocoSession } from '../../src/runtime.js';
import { buildV1Routes, createV1RouteDefinitions, resourceEventSchema } from '../../src/v1/http.js';
import type { ResourceEventDocument } from '../../src/v1/resources/event-schemas.js';
import { startFakeMint } from '../helpers/fake-mint.js';
import { startTcpTestServer } from '../helpers/tcp.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real host lifecycle, Manager, file-backed SQLite, credential store, and TCP transport. */
async function startHarness() {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-events-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const mint = startFakeMint();
  cleanups.push(() => mint.stop());
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
      const manager = await initializeCoco({
        repo: new SqliteRepositories({ database }),
        seedGetter: async () => mnemonicToSeedSync(config.mnemonic),
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
      });
      // NPC is outside the event boundary; no NPC methods are invoked by these routes.
      return {
        manager,
        mintUrl: config.mintUrl,
        npcAccount: {} as RunningCocoSession['npcAccount'],
      };
    },
  });
  cleanups.push(() => runtime.dispose());
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const clientFile = join(credentialDirectory, 'current', 'client');
  const credential = await loadClientCredential(clientFile);
  const server = startTcpTestServer({
    routes: buildV1Routes(
      createV1RouteDefinitions(
        runtime,
        'test',
        {
          request: () => Promise.reject(new Error('unexpected process shutdown')),
        },
        undefined,
        { eventKeepAliveIntervalMs: 10 },
      ),
      credentials,
    ),
    fetch: () => new Response('not found', { status: 404 }),
  });
  cleanups.push(() => server.stop(true));
  const call = (path: string, options: { body?: unknown; credential?: string } = {}) =>
    fetch(new URL(path, server.url), {
      method: options.body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${options.credential ?? credential}`,
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  const initialized = await call('/v1/admin/wallet/initialize', { body: {} });
  expect(initialized.status).toBe(202);
  await initialized.json();
  await runtime.startSession().completion;
  return {
    runtime,
    mint,
    call,
    client: createV1Client({ url: server.url.toString(), credentialFile: clientFile }),
    rotate: async () => {
      await credentials.rotate();
      return loadClientCredential(clientFile);
    },
    setCapabilities: async (capabilities: string[]) => {
      const verifierFile = join(credentialDirectory, 'current', 'verifier.json');
      const state = JSON.parse(await readFile(verifierFile, 'utf8'));
      // Publish a complete verifier atomically, as host-local credential changes do.
      const temporary = join(credentialDirectory, 'current', 'verifier.next');
      await writeFile(temporary, JSON.stringify({ ...state, capabilities }), { mode: 0o600 });
      await rename(temporary, verifierFile);
    },
    stream: async () => {
      const response = await call('/v1/events');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-request-id')).toBeTruthy();
      const reader = response.body!.getReader();
      cleanups.push(() => reader.cancel());
      const decoder = new TextDecoder();
      let buffer = '';
      const frame = async (): Promise<string | null> => {
        while (!buffer.includes('\n\n')) {
          const { done, value } = await reader.read();
          if (done) return null;
          buffer += decoder.decode(value, { stream: true });
        }
        const end = buffer.indexOf('\n\n');
        const result = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        return result;
      };
      expect(await frame()).toBe(': connected');
      return {
        frame,
        event: async (type: ResourceEventDocument['type']) => {
          for (;;) {
            const next = await frame();
            if (next === null) throw new Error(`stream ended before ${type}`);
            if (!next.startsWith('data: ')) continue;
            const event = resourceEventSchema.parse(JSON.parse(next.slice(6)));
            if (event.type === type) return event;
          }
        },
        end: async () => {
          while ((await frame()) !== null) {
            /* drain buffered frames */
          }
        },
      };
    },
  };
}

test('raw authenticated HTTP streams committed Mint, Quote, Operation and history invalidations', async () => {
  const harness = await startHarness();
  const stream = await harness.stream();
  const registered = await harness.call('/v1/mints', {
    body: { mintUrl: harness.mint.url, trusted: true },
  });
  expect(registered.status).toBe(200);
  await registered.json();
  expect(await stream.event('mint.updated')).toMatchObject({ data: { mintUrl: harness.mint.url } });
  const created = await harness.call('/v1/quotes/mint', {
    body: { method: 'bolt11', amount: '5', mintUrl: harness.mint.url },
  });
  expect(created.status).toBe(201);
  const quote = (await created.json()) as { quoteId: string };
  expect(await stream.event('quote.updated')).toMatchObject({
    data: {
      quoteType: 'mint',
      mintUrl: harness.mint.url,
      method: 'bolt11',
      quoteId: quote.quoteId,
    },
  });
  const prepared = await harness.call('/v1/operations/mint', {
    body: { mintUrl: harness.mint.url, quoteId: quote.quoteId, amount: '5' },
  });
  expect(prepared.status).toBe(201);
  const operation = (await prepared.json()) as { id: string };
  // History and operation notifications can arrive in either order. Both refer to committed rows.
  const observed = new Map<string, ResourceEventDocument>();
  while (!observed.has('history.updated') || !observed.has('operation.updated')) {
    const frame = await stream.frame();
    if (frame === null) throw new Error('stream ended before operation notifications');
    if (!frame.startsWith('data: ')) continue;
    const event = resourceEventSchema.parse(JSON.parse(frame.slice(6)));
    observed.set(event.type, event);
  }
  expect(observed.get('operation.updated')).toMatchObject({
    data: { operationType: 'mint', operationId: operation.id, mintUrl: harness.mint.url },
  });
  const history = observed.get('history.updated')!;
  expect(history).toMatchObject({ data: { type: 'mint', operationId: operation.id, amount: '5' } });
  if (history.type !== 'history.updated') throw new Error('missing history');
  const read = await harness.call(`/v1/history/${encodeURIComponent(history.data.id)}`);
  const storedHistory = (await read.json()) as typeof history.data;
  const { createdAt, updatedAt, ...identityAndState } = history.data;
  expect(storedHistory).toMatchObject(identityAndState);
  // SQLite persists these timestamps in seconds; live projections retain milliseconds.
  expect(Date.parse(storedHistory.createdAt)).toBe(
    Math.floor(Date.parse(createdAt) / 1_000) * 1_000,
  );
  expect(Date.parse(storedHistory.updatedAt)).toBe(
    Math.floor(Date.parse(updatedAt) / 1_000) * 1_000,
  );
  const stopped = await harness.call('/v1/admin/session/stop', { body: {} });
  expect([200, 202]).toContain(stopped.status);
  await stopped.json();
  await harness.runtime.stopSession();
  await stream.end();
  const reconnect = await harness.call('/v1/events');
  expect(reconnect.status).toBe(503);
  expect(reconnect.headers.get('content-type')).toContain('application/json');
  expect(reconnect.headers.get('cache-control')).toBe('no-store');
  expect(await reconnect.json()).toMatchObject({ error: { code: 'session_stopped' } });
});

test('rotating the stored credential closes an existing HTTP stream and rejects the old credential', async () => {
  const harness = await startHarness();
  const stream = await harness.stream();
  const replacement = await harness.rotate();
  await stream.end();
  const rejected = await harness.call('/v1/events');
  expect(rejected.status).toBe(401);
  expect(rejected.headers.get('cache-control')).toBe('no-store');
  expect(await rejected.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  const accepted = await harness.call('/v1/events', { credential: replacement });
  expect(accepted.status).toBe(200);
  await accepted.body!.cancel();
});

test('HTTP streams retain read-only access but close when wallet:read is removed', async () => {
  const harness = await startHarness();
  const stream = await harness.stream();
  await harness.setCapabilities(['wallet:read']);
  const readOnlyStream = await harness.stream();
  expect(await readOnlyStream.frame()).toBe(': keep-alive');
  await harness.setCapabilities(['wallet:admin']);
  await stream.end();
  await readOnlyStream.end();
  const rejected = await harness.call('/v1/events');
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get('cache-control')).toBe('no-store');
  expect(await rejected.json()).toMatchObject({ error: { code: 'forbidden' } });
});

test('CLI history watch refetches committed entries and terminates after the real Coco Session stops', async () => {
  const harness = await startHarness();
  await harness.client.registerMint({ mintUrl: harness.mint.url, trusted: true });
  const firstEntry = Promise.withResolvers<unknown>();
  const seen: string[] = [];
  const watching = watchHistory(harness.client, [], {
    limit: 5,
    onEntry: (entry) => {
      seen.push(entry.id);
      firstEntry.resolve(entry);
    },
    reconnectDelayMs: 0,
  });
  // Attach the rejection handler immediately so a terminal error is always owned by the test.
  const stopped = watching.catch((error: unknown) => error);
  expect(
    await requestBolt11Receive(harness.client, { amount: '5', mintUrl: harness.mint.url }),
  ).toBe('lnbc5fake');
  expect(await firstEntry.promise).toMatchObject({
    type: 'mint',
    amount: '5',
    unit: 'sat',
    state: 'pending',
  });
  await harness.client.stopSession();
  await harness.runtime.stopSession();
  expect(await stopped).toMatchObject({ status: 503, code: 'session_stopped' });
  expect(new Set(seen).size).toBe(1);
  expect(seen).toHaveLength(1);
  // A new watcher fails without delivering any callback after shutdown.
  await expect(
    watchHistory(harness.client, [], {
      limit: 5,
      onEntry: () => {
        throw new Error('late history callback');
      },
      reconnectDelayMs: 0,
    }),
  ).rejects.toMatchObject({ code: 'session_stopped' });
});
