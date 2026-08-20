import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createV1Client, prepareAndExecuteCashuReceive } from '../../src/cli-shared.js';
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

test('superseded Cashu-receive route is not exposed', () => {
  const routes = createRouteHandlers({} as CocodRuntime);

  expect(routes['/receive/cashu']).toBeUndefined();
});
