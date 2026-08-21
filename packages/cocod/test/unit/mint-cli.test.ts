import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV1Client, registerAndTrustMint } from '../../src/cli-shared.js';
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

test('Mint CLI requests use v1 resources and add explicitly grants trust', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-mint-cli-'));
  directories.push(directory);
  const credentialFile = join(directory, 'client');
  await writeFile(credentialFile, 'm'.repeat(43), { mode: 0o600 });
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    requests.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
    });
    if (url.pathname === '/v1/mints' && (init?.method ?? 'GET') === 'GET') {
      return Response.json({ items: [] });
    }
    if (url.pathname === '/v1/mints/info') {
      return Response.json({
        mintUrl: 'https://mint.example.com',
        info: { name: 'Example Mint' },
      });
    }
    return Response.json({
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      trusted: url.pathname.endsWith('/trust'),
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile, url: 'https://wallet.example.com' });

  const result = await registerAndTrustMint(client, 'https://mint.example.com/');
  await client.listMints({ trustedOnly: true });
  await client.getMintInfo('https://mint.example.com/');

  expect(result.trusted).toBe(true);
  expect(requests).toEqual([
    {
      path: '/v1/mints',
      method: 'POST',
      body: { mintUrl: 'https://mint.example.com/' },
    },
    {
      path: '/v1/mints/trust',
      method: 'POST',
      body: { mintUrl: 'https://mint.example.com' },
    },
    { path: '/v1/mints?trustedOnly=true', method: 'GET' },
    {
      path: '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com%2F',
      method: 'GET',
    },
  ]);
});

test('superseded Mint routes are not exposed', () => {
  const routes = createRouteHandlers({} as CocodRuntime);

  expect(routes['/mints/add']).toBeUndefined();
  expect(routes['/mints/list']).toBeUndefined();
  expect(routes['/mints/info']).toBeUndefined();
});
