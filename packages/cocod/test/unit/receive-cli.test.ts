import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createV1Client,
  prepareAndExecuteCashuReceive,
  prepareBolt11Receive,
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

test('Cashu-receive CLI flow prepares and executes through v1 while reporting the amount', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-receive-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 'r'.repeat(43), { mode: 0o600 });
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  const operation = {
    id: 'receive-operation-cli',
    type: 'receive' as const,
    state: 'prepared' as const,
    mintUrl: 'https://mint.example.com',
    unit: 'sat',
    amount: '25',
    fee: '1',
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
    return Response.json(
      url.pathname.endsWith('/execute') ? { ...operation, state: 'finalized' } : operation,
      { status: url.pathname.endsWith('/execute') ? 200 : 201 },
    );
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const output = await prepareAndExecuteCashuReceive(client, 'cashuBcli-input');

  expect(output).toBe('Received 25');
  expect(requests).toEqual([
    {
      path: '/v1/operations/receive',
      method: 'POST',
      body: { token: 'cashuBcli-input' },
    },
    {
      path: '/v1/operations/receive/receive-operation-cli/execute',
      method: 'POST',
    },
  ]);
});

test('Lightning-receive CLI flow creates a Quote and prepares a pending Mint Operation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-mint-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 'm'.repeat(43), { mode: 0o600 });
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({
      path: url.pathname,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.pathname === '/v1/quotes/mint') {
      return Response.json(
        {
          type: 'mint',
          method: 'bolt11',
          mintUrl: 'https://mint.example.com',
          quoteId: 'mint-quote-cli',
          request: 'lnbc250n1cli-invoice',
          unit: 'sat',
          amount: '25',
          amountPaid: '0',
          amountIssued: '0',
          reusable: false,
          state: 'UNPAID',
          expiry: '2026-08-16T00:05:00.000Z',
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:01:00.000Z',
        },
        { status: 201 },
      );
    }
    return Response.json(
      {
        id: 'mint-operation-cli',
        type: 'mint',
        state: 'pending',
        mintUrl: 'https://mint.example.com',
        unit: 'sat',
        method: 'bolt11',
        amount: '25',
        quote: { mintUrl: 'https://mint.example.com', quoteId: 'mint-quote-cli' },
        expiry: '2026-08-16T00:05:00.000Z',
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:01:00.000Z',
      },
      { status: 201 },
    );
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const invoice = await prepareBolt11Receive(client, {
    amount: '25',
    mintUrl: 'https://mint.example.com',
  });

  expect(invoice).toBe('lnbc250n1cli-invoice');
  expect(requests).toEqual([
    {
      path: '/v1/quotes/mint',
      method: 'POST',
      body: {
        mintUrl: 'https://mint.example.com',
        method: 'bolt11',
        amount: '25',
        unit: 'sat',
      },
    },
    {
      path: '/v1/operations/mint',
      method: 'POST',
      body: {
        mintUrl: 'https://mint.example.com',
        quoteId: 'mint-quote-cli',
        amount: '25',
      },
    },
  ]);
});

test('superseded Cashu-receive route is not exposed', () => {
  const routes = createRouteHandlers({} as CocodRuntime);

  expect(routes['/receive/cashu']).toBeUndefined();
  expect(routes['/receive/bolt11']).toBeUndefined();
});
