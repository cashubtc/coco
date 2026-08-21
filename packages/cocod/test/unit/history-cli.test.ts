import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV1Client, formatHistory, watchHistoryUpdates } from '../../src/cli-shared.js';
import { createRouteHandlers } from '../../src/routes.js';
import type { CocodRuntime } from '../../src/runtime.js';

const originalFetch = globalThis.fetch;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('history CLI reads safe v1 list and detail resources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-history-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 'h'.repeat(43), { mode: 0o600 });
  const entry = {
    id: 'melt:melt-operation-1',
    source: 'operation' as const,
    type: 'melt' as const,
    operationId: 'melt-operation-1',
    quoteId: 'melt-quote-1',
    state: 'finalized',
    mintUrl: 'https://mint.example.com',
    unit: 'sat',
    amount: '25',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
  };
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(`${url.pathname}${url.search}`);
    return Response.json(
      url.pathname === '/v1/history' ? { items: [entry], offset: 2, limit: 1 } : entry,
    );
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const page = await client.listHistory({ offset: 2, limit: 1 });
  const detail = await client.getHistory('melt:melt-operation-1');
  const formatted = formatHistory(page);

  expect(detail).toEqual(entry);
  expect(JSON.parse(formatted)).toEqual([entry]);
  expect(formatted).toContain('\n  {');
  expect(requests).toEqual(['/v1/history?offset=2&limit=1', '/v1/history/melt%3Amelt-operation-1']);
});

test('legacy history and event routes are removed', () => {
  const routes = createRouteHandlers({} as CocodRuntime);

  expect(routes['/history']).toBeUndefined();
  expect(routes['/events']).toBeUndefined();
});

test('history watch consumes v1 invalidations and refetches canonical history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-history-watch-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 'w'.repeat(43), { mode: 0o600 });
  const entry = {
    id: 'send:send-operation-2',
    source: 'operation' as const,
    type: 'send' as const,
    operationId: 'send-operation-2',
    state: 'finalized',
    mintUrl: 'https://mint.example.com',
    unit: 'sat',
    amount: '12',
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
  };
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', interfaceVersion: '1' });
    }
    if (url.pathname === '/v1/status') {
      return Response.json({
        daemon: { version: '0.0.17', interfaceVersion: '1' },
        wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
        seedAccess: { state: 'available', requiresPassphrase: false },
        cocoSession: {
          state: 'running',
          startedAt: '2026-08-16T00:00:01.000Z',
          lastFailure: null,
        },
      });
    }
    if (url.pathname === '/v1/events') {
      return new Response(
        'data: {"type":"balance.updated","timestamp":"2026-08-16T00:02:00.000Z","data":{"mintUrl":"https://mint.example.com"}}\n\n' +
          'data: {"type":"history.updated","timestamp":"2026-08-16T00:03:00.000Z","data":{"id":"send:send-operation-2","source":"operation","type":"send","operationId":"send-operation-2","state":"finalized","mintUrl":"https://mint.example.com","unit":"sat","amount":"12","createdAt":"2026-08-16T00:00:00.000Z","updatedAt":"2026-08-16T00:01:00.000Z"}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    }
    return Response.json({ items: [entry], offset: 0, limit: 1 });
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });
  const updates: unknown[] = [];

  await watchHistoryUpdates(
    client,
    { limit: 1 },
    (history) => {
      updates.push(history);
    },
    { credentialFile, url: 'https://wallet.example.com' },
  );

  expect(updates).toEqual([{ items: [entry], offset: 0, limit: 1 }]);
  expect(requests).toEqual(['/health', '/v1/status', '/v1/events', '/v1/history?offset=0&limit=1']);
});
