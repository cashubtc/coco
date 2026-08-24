import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAmount, type CoreEvents } from '@cashu/coco-core';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import type { CocodStatus } from '../../src/runtime.js';
import { buildV1Routes, createV1RouteDefinitions, type V1Runtime } from '../../src/v1/http.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('streams safe refetchable invalidations for every v1 event kind', async () => {
  const credential = await createCredential();
  const manager = new FakeManager();
  const routes = createRoutes(manager, credential.credentials);
  const abort = new AbortController();
  const response = await routes['/v1/events']!.GET!(
    new Request('http://localhost/v1/events', {
      headers: { Authorization: `Bearer ${credential.plaintext}` },
      signal: abort.signal,
    }),
  );
  const reader = response.body!.getReader();

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('no-store');

  await readSseBlock(reader); // connected comment

  await manager.emit('history:updated', {
    mintUrl: 'https://mint.example.com/',
    entry: {
      id: 'send:send-operation-1',
      source: 'operation',
      type: 'send',
      operationId: 'send-operation-1',
      state: 'pending',
      mintUrl: 'https://mint.example.com/',
      unit: 'sat',
      amount: toAmount(21),
      createdAt: 1_786_838_500_000,
      updatedAt: 1_786_838_560_000,
      token: {
        mint: 'https://mint.example.com',
        proofs: [{ secret: 'history-secret-must-not-leak' }],
      },
    } as CoreEvents['history:updated']['entry'],
  });
  const history = await readSseEvent(reader);

  await manager.emit('send:pending', {
    mintUrl: 'https://mint.example.com/',
    operationId: 'send-operation-1',
    operation: { token: 'operation-secret-must-not-leak' },
    token: { proofs: [{ secret: 'token-secret-must-not-leak' }] },
  } as unknown as CoreEvents['send:pending']);
  const operation = await readSseEvent(reader);

  await manager.emit('mint-quote:updated', {
    mintUrl: 'https://mint.example.com/',
    method: 'bolt11',
    quoteId: 'mint-quote-1',
    quote: { request: 'invoice-must-not-leak' },
  } as unknown as CoreEvents['mint-quote:updated']);
  const quote = await readSseEvent(reader);

  await manager.emit('mint:updated', {
    mint: {
      mintUrl: 'https://mint.example.com/',
      mintInfo: { private: 'mint-info-must-not-leak' },
    },
    keysets: [{ publicKeys: { 1: 'keyset-must-not-leak' } }],
  } as unknown as CoreEvents['mint:updated']);
  const mint = await readSseEvent(reader);

  await manager.emit('proofs:saved', {
    mintUrl: 'https://mint.example.com/',
    keysetId: 'keyset-must-not-leak',
    proofs: [{ secret: 'proof-secret-must-not-leak' }],
  } as unknown as CoreEvents['proofs:saved']);
  const balance = await readSseEvent(reader);

  expect(history).toMatchObject({
    type: 'history.updated',
    data: {
      id: 'send:send-operation-1',
      source: 'operation',
      type: 'send',
      operationId: 'send-operation-1',
      state: 'pending',
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      amount: '21',
      createdAt: '2026-08-16T00:01:40.000Z',
      updatedAt: '2026-08-16T00:02:40.000Z',
    },
  });
  expect(operation).toMatchObject({
    type: 'operation.updated',
    data: {
      operationType: 'send',
      operationId: 'send-operation-1',
      mintUrl: 'https://mint.example.com',
    },
  });
  expect(quote).toMatchObject({
    type: 'quote.updated',
    data: {
      quoteType: 'mint',
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      quoteId: 'mint-quote-1',
    },
  });
  expect(mint).toMatchObject({
    type: 'mint.updated',
    data: { mintUrl: 'https://mint.example.com' },
  });
  expect(balance).toMatchObject({
    type: 'balance.updated',
    data: { mintUrl: 'https://mint.example.com' },
  });
  for (const event of [history, operation, quote, mint, balance]) {
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }
  const serialized = JSON.stringify([history, operation, quote, mint, balance]);
  expect(serialized).not.toContain('must-not-leak');

  abort.abort();
  await reader.cancel();
});

test('authenticates the event stream and removes every Coco listener on disconnect', async () => {
  const credential = await createCredential();
  const manager = new FakeManager();
  const routes = createRoutes(manager, credential.credentials);

  const unauthorized = await routes['/v1/events']!.GET!(new Request('http://localhost/v1/events'));
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  expect(unauthorized.headers.get('cache-control')).toBe('no-store');
  expect(manager.listenerCount()).toBe(0);

  const cursor = await routes['/v1/events']!.GET!(
    new Request('http://localhost/v1/events?cursor=event-1', {
      headers: { Authorization: `Bearer ${credential.plaintext}` },
    }),
  );
  expect(cursor.status).toBe(400);
  expect(await cursor.json()).toMatchObject({ error: { code: 'invalid_request' } });
  expect(manager.listenerCount()).toBe(0);

  const abort = new AbortController();
  const response = await routes['/v1/events']!.GET!(
    new Request('http://localhost/v1/events', {
      headers: { Authorization: `Bearer ${credential.plaintext}` },
      signal: abort.signal,
    }),
  );
  const reader = response.body!.getReader();
  const connected = await readSseBlock(reader);
  expect(connected).toBe(': connected');
  expect(connected).not.toContain('id:');
  expect(manager.listenerCount()).toBeGreaterThan(0);

  abort.abort();
  await Bun.sleep(0);

  expect(manager.listenerCount()).toBe(0);
  await reader.cancel();
});

test('bounds queued invalidations when an event client stops reading', async () => {
  const credential = await createCredential();
  const manager = new FakeManager();
  const routes = createRoutes(manager, credential.credentials);
  const abort = new AbortController();
  const response = await routes['/v1/events']!.GET!(
    new Request('http://localhost/v1/events', {
      headers: { Authorization: `Bearer ${credential.plaintext}` },
      signal: abort.signal,
    }),
  );
  const reader = response.body!.getReader();

  await readSseBlock(reader); // connected comment
  await manager.emit('mint:trusted', { mintUrl: 'https://first.example.com' });
  await manager.emit('mint:trusted', { mintUrl: 'https://dropped.example.com' });

  expect(await readSseEvent(reader)).toMatchObject({
    type: 'mint.updated',
    data: { mintUrl: 'https://first.example.com' },
  });

  await manager.emit('mint:trusted', { mintUrl: 'https://third.example.com' });
  expect(await readSseEvent(reader)).toMatchObject({
    type: 'mint.updated',
    data: { mintUrl: 'https://third.example.com' },
  });

  abort.abort();
  await reader.cancel();
});

test('closes an open event stream after its credential is rotated', async () => {
  const credential = await createCredential();
  const manager = new FakeManager();
  const routes = createRoutes(manager, credential.credentials, {
    eventAuthorizationRevalidationIntervalMs: 10,
  });
  const response = await routes['/v1/events']!.GET!(
    new Request('http://localhost/v1/events', {
      headers: { Authorization: `Bearer ${credential.plaintext}` },
    }),
  );
  const reader = response.body!.getReader();

  await readSseBlock(reader); // connected comment
  await credential.credentials.rotate();

  const result = await Promise.race([
    reader.read(),
    Bun.sleep(200).then(() => ({ done: false, timedOut: true as const })),
  ]);
  expect(result).toMatchObject({ done: true });
  expect(result).not.toHaveProperty('timedOut');
  expect(manager.listenerCount()).toBe(0);
});

class FakeManager {
  private readonly listeners = new Map<keyof CoreEvents, Set<(payload: unknown) => unknown>>();

  on<E extends keyof CoreEvents>(
    event: E,
    listener: (payload: CoreEvents[E]) => void | Promise<void>,
  ): () => void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener as (payload: unknown) => unknown);
    this.listeners.set(event, listeners);
    return () => {
      listeners.delete(listener as (payload: unknown) => unknown);
      if (listeners.size === 0) this.listeners.delete(event);
    };
  }

  async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) {
      await listener(payload);
    }
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

function createRoutes(
  manager: FakeManager,
  credentials: AdministrativeCredential,
  options: { eventAuthorizationRevalidationIntervalMs?: number } = {},
): ReturnType<typeof buildV1Routes> {
  const status: CocodStatus = {
    wallet: {
      configuredAt: '2026-08-16T00:00:00.000Z',
      mintUrl: 'https://mint.example.com',
    },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: {
      state: 'running',
      startedAt: '2026-08-16T00:00:01.000Z',
      lastFailure: null,
    },
  };
  const runtime = {
    getStatus: () => status,
    getRunningSession: () => ({
      manager,
      mintUrl: 'https://mint.example.com',
      npcAccount: {},
    }),
  } as unknown as V1Runtime;
  const shutdown = { request: mock(() => Promise.resolve(0)) };
  return buildV1Routes(
    createV1RouteDefinitions(runtime, '0.0.17', shutdown, undefined, options),
    credentials,
  );
}

async function createCredential(): Promise<{
  credentials: AdministrativeCredential;
  plaintext: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-events-'));
  directories.push(directory);
  const currentDirectory = join(directory, 'credentials', 'current');
  const credentials = await AdministrativeCredential.loadOrBootstrap({
    credentialDirectory: join(directory, 'credentials'),
  });
  return {
    credentials,
    plaintext: await loadClientCredential(join(currentDirectory, 'client')),
  };
}

type SseReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
};

async function readSseBlock(reader: SseReader): Promise<string> {
  let buffer = '';
  while (!buffer.includes('\n\n')) {
    const { done, value } = await reader.read();
    if (done) throw new Error('SSE stream ended before the next event');
    buffer += new TextDecoder().decode(value ?? new Uint8Array());
  }
  return buffer.slice(0, buffer.indexOf('\n\n'));
}

async function readSseEvent(reader: SseReader): Promise<Record<string, unknown>> {
  const block = await readSseBlock(reader);
  const line = block.split('\n').find((candidate) => candidate.startsWith('data: '));
  if (!line) throw new Error(`SSE block did not contain data: ${block}`);
  return JSON.parse(line.slice(6)) as Record<string, unknown>;
}
