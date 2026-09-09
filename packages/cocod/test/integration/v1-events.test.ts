import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAmount, type CoreEvents } from '@cashu/coco-core';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import type { CocodStatus } from '../../src/runtime.js';
import { buildV1Routes, createV1RouteDefinitions, type V1Runtime } from '../../src/v1/http.js';
import { startTcpTestServer } from '../helpers/tcp.js';

const directories: string[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('serves authenticated v1 invalidations over TCP', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-events-tcp-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  const manager = new FakeManager();
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
  server = startTcpTestServer({
    routes: buildV1Routes(createV1RouteDefinitions(runtime, '0.0.17', shutdown), credentials),
    fetch: () => new Response('Not found', { status: 404 }),
  });

  const unauthorized = await fetch(new URL('/v1/events', server.url));
  expect(unauthorized.status).toBe(401);

  const abort = new AbortController();
  const response = await fetch(new URL('/v1/events', server.url), {
    headers: { Authorization: `Bearer ${plaintext}` },
    signal: abort.signal,
  });
  const reader = response.body!.getReader();
  await reader.read(); // connected comment

  await manager.emit('history:updated', {
    mintUrl: 'https://mint.example.com',
    entry: {
      id: 'receive:receive-operation-1',
      source: 'operation',
      type: 'receive',
      operationId: 'receive-operation-1',
      state: 'finalized',
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      amount: toAmount(7),
      createdAt: 1_786_838_500_000,
      updatedAt: 1_786_838_560_000,
    },
  });
  const event = await reader.read();
  const body = new TextDecoder().decode(event.value);

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(body).toContain('"type":"history.updated"');
  expect(body).toContain('"id":"receive:receive-operation-1"');
  expect(body).not.toContain('id: ');

  abort.abort();
  await reader.cancel();
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
    return () => listeners.delete(listener as (payload: unknown) => unknown);
  }

  async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) await listener(payload);
  }
}
