import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createV1Client,
  prepareAndExecuteBolt11Send,
  prepareAndExecuteCashuSend,
} from '../../src/cli-shared.js';
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

test('Cashu-send CLI flow prepares and executes through v1 while returning the token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-send-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 's'.repeat(43), { mode: 0o600 });
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const operation = {
    id: 'send-operation-cli',
    type: 'send' as const,
    state: 'prepared' as const,
    mintUrl: 'https://mint.example.com',
    unit: 'sat',
    method: 'default' as const,
    requestedAmount: '25',
    inputAmount: '25',
    fee: '0',
    needsSwap: false,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:01:00.000Z',
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.pathname.endsWith('/execute')) {
      return Response.json({
        operation: { ...operation, state: 'pending' },
        result: { token: 'cashuBcli-output' },
      });
    }
    return Response.json(operation, { status: 201 });
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const token = await prepareAndExecuteCashuSend(client, {
    amount: '25',
    mintUrl: 'https://mint.example.com',
  });

  expect(token).toBe('cashuBcli-output');
  expect(requests).toEqual([
    {
      path: '/v1/operations/send',
      method: 'POST',
      body: { mintUrl: 'https://mint.example.com', amount: '25', unit: 'sat' },
    },
    {
      path: '/v1/operations/send/send-operation-cli/execute',
      method: 'POST',
    },
  ]);
});

test('superseded Cashu-send route is not exposed', () => {
  const routes = createRouteHandlers({} as CocodRuntime);

  expect(routes['/send/cashu']).toBeUndefined();
  expect(routes['/send/bolt11']).toBeUndefined();
});

test('Lightning-send CLI flow creates a Quote, prepares a Melt Operation, and executes it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-melt-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 's'.repeat(43), { mode: 0o600 });
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      ...(body !== undefined ? { body } : {}),
    });
    if (url.pathname === '/v1/quotes/melt') {
      return Response.json(
        {
          type: 'melt',
          method: 'bolt11',
          mintUrl: 'https://mint.example.com',
          quoteId: 'melt-quote-cli',
          request: 'lnbc1cli',
          unit: 'sat',
          amount: '25',
          state: 'UNPAID',
          feeReserve: '2',
          expiry: '2026-08-16T00:05:00.000Z',
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:01:00.000Z',
        },
        { status: 201 },
      );
    }
    const operation = {
      id: 'melt-operation-cli',
      type: 'melt' as const,
      state: url.pathname.endsWith('/execute') ? ('pending' as const) : ('prepared' as const),
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      method: 'bolt11' as const,
      amount: '25',
      quote: { mintUrl: 'https://mint.example.com', quoteId: 'melt-quote-cli' },
      feeReserve: '2',
      swapFee: '0',
      inputAmount: '27',
      needsSwap: false,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    };
    return Response.json(
      url.pathname.endsWith('/execute') ? { operation } : operation,
      url.pathname.endsWith('/execute') ? undefined : { status: 201 },
    );
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const output = await prepareAndExecuteBolt11Send(client, {
    invoice: 'lnbc1cli',
    mintUrl: 'https://mint.example.com',
  });

  expect(output).toBe('Paid invoice: lnbc1cli');
  expect(requests).toEqual([
    {
      path: '/v1/quotes/melt',
      method: 'POST',
      body: {
        mintUrl: 'https://mint.example.com',
        method: 'bolt11',
        invoice: 'lnbc1cli',
      },
    },
    {
      path: '/v1/operations/melt',
      method: 'POST',
      body: { mintUrl: 'https://mint.example.com', quoteId: 'melt-quote-cli' },
    },
    {
      path: '/v1/operations/melt/melt-operation-cli/execute',
      method: 'POST',
    },
  ]);
});
