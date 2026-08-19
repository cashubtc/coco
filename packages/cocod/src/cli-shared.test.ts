import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHostLocalOperation,
  callDaemonStream,
  createV1Client,
  DEFAULT_SESSION_TRANSITION_TIMEOUT_MS,
  ensureDaemonRunning,
  formatBalances,
  registerAndTrustMint,
  handleWalletV1Command,
  startDaemonProcess,
  V1ClientError,
  waitForSessionTransition,
  type V1Client,
} from './cli-shared';

const originalFetch = globalThis.fetch;
const originalSpawn = Bun.spawn;
const directories: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = originalSpawn;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('typed v1 status requests attach the file-backed bearer credential', async () => {
  const credentialFile = await temporaryCredentialFile('a'.repeat(43));
  const authorizations: Array<string | null> = [];
  const requestedUrls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrls.push(input instanceof Request ? input.url : input.toString());
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json(lifecycleStatus('stopped'));
  }) as unknown as typeof fetch;

  const status = await createV1Client({
    credentialFile,
    url: 'https://wallet.example.com',
  }).status();

  expect(status.cocoSession.state).toBe('stopped');
  expect(authorizations).toEqual([`Bearer ${'a'.repeat(43)}`]);
  expect(requestedUrls).toEqual(['https://wallet.example.com/v1/status']);
});

test('typed v1 balance requests preserve repeatable filters and decimal strings', async () => {
  const credentialFile = await temporaryCredentialFile('b'.repeat(43));
  const requestedUrls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    requestedUrls.push(input instanceof Request ? input.url : input.toString());
    return Response.json({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          spendable: '9007199254740993',
          reserved: '7',
          total: '9007199254741000',
        },
      ],
    });
  }) as unknown as typeof fetch;

  const balances = await createV1Client({
    credentialFile,
    url: 'https://wallet.example.com',
  }).balances({
    mintUrls: ['https://mint.example.com', 'https://mint.other'],
    units: ['sat', 'usd'],
    trustedOnly: false,
  });

  expect(balances.items[0]?.total).toBe('9007199254741000');
  expect(requestedUrls).toEqual([
    'https://wallet.example.com/v1/balances?mintUrl=https%3A%2F%2Fmint.example.com&mintUrl=https%3A%2F%2Fmint.other&unit=sat&unit=usd&trustedOnly=false',
  ]);
});

test('typed v1 Mint requests use resource routes and the add flow explicitly grants trust', async () => {
  const credentialFile = await temporaryCredentialFile('m'.repeat(43));
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
    {
      path: '/v1/mints?trustedOnly=true',
      method: 'GET',
    },
    {
      path: '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com%2F',
      method: 'GET',
    },
  ]);
});

test('formats structured balances without discarding reserved amounts or units', () => {
  expect(
    formatBalances({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          spendable: '1200',
          reserved: '300',
          total: '1500',
        },
        {
          mintUrl: 'https://mint.example.com',
          unit: 'usd',
          spendable: '4',
          reserved: '1',
          total: '5',
        },
      ],
    }),
  ).toBe(
    'https://mint.example.com\n  sat: 1500 total (1200 spendable, 300 reserved)\n  usd: 5 total (4 spendable, 1 reserved)',
  );
  expect(formatBalances({ items: [] })).toBe('No balances.');
});

test('wallet v1 commands wait for an auto-started Coco Session before requesting balances', async () => {
  const credentialFile = await temporaryCredentialFile('w'.repeat(43));
  const requestedPaths: string[] = [];
  let statusRequests = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    requestedPaths.push(path);
    if (path === '/health') {
      return Response.json({ status: 'ok', interfaceVersion: '1' });
    }
    if (path === '/v1/status') {
      statusRequests += 1;
      return Response.json(lifecycleStatus(statusRequests === 1 ? 'starting' : 'running'));
    }
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;

  await handleWalletV1Command((client) => client.balances(), {
    credentialFile,
    url: 'https://wallet.example.com',
  });

  expect(requestedPaths).toEqual(['/health', '/v1/status', '/v1/status', '/v1/balances']);
});

test('the liveness request remains credential-free', async () => {
  const authorizations: Array<string | null> = [];
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ status: 'ok', interfaceVersion: '1' });
  }) as unknown as typeof fetch;

  await createV1Client({ credentialFile: '/missing/credential' }).health();

  expect(authorizations).toEqual([null]);
});

test('typed v1 requests expose structured error fields', async () => {
  const credentialFile = await temporaryCredentialFile('e'.repeat(43));
  globalThis.fetch = mock(async () =>
    Response.json(
      {
        error: {
          code: 'wallet_not_configured',
          message: 'No Wallet is configured',
          retryable: false,
          details: { operation: 'session_start' },
        },
      },
      { status: 409 },
    ),
  ) as unknown as typeof fetch;

  try {
    await createV1Client({ credentialFile }).startSession({});
    throw new Error('expected v1 request to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(V1ClientError);
    expect(error).toMatchObject({
      code: 'wallet_not_configured',
      message: 'No Wallet is configured',
      retryable: false,
      details: { operation: 'session_start' },
      status: 409,
    });
  }
});

test('Coco Session stop and Cocod Process stop use distinct v1 resources', async () => {
  const credentialFile = await temporaryCredentialFile('f'.repeat(43));
  const requestedPaths: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    requestedPaths.push(path);
    if (path === '/v1/admin/process/stop') {
      return Response.json({ status: 'stopping' }, { status: 202 });
    }
    return Response.json(lifecycleStatus('stopped'));
  }) as unknown as typeof fetch;
  const client = createV1Client({ credentialFile });

  await client.stopSession();
  await client.stopProcess();

  expect(requestedPaths).toEqual(['/v1/admin/session/stop', '/v1/admin/process/stop']);
});

test('the lifecycle wait exceeds the server cleanup deadline', () => {
  expect(DEFAULT_SESSION_TRANSITION_TIMEOUT_MS).toBeGreaterThan(30_000);
});

test('the lifecycle wait timing is configurable', async () => {
  const client = {
    status: async () => lifecycleStatus('starting'),
  } as unknown as V1Client;

  await expect(
    waitForSessionTransition(client, lifecycleStatus('starting'), {
      timeoutMs: 5,
      pollIntervalMs: 1,
    }),
  ).rejects.toThrow('Coco Session transition did not finish within 1 seconds');
});

test('host-local operations reject an explicit remote endpoint', () => {
  expect(() => assertHostLocalOperation('logs', 'https://wallet.example.com')).toThrow(
    'cocod logs is host-local and cannot use the explicit Cocod endpoint https://wallet.example.com',
  );
  expect(() => assertHostLocalOperation('logs', undefined, {})).not.toThrow();
});

test('streaming requests attach the file-backed bearer credential', async () => {
  const credentialFile = await temporaryCredentialFile('c'.repeat(43));
  const streamAuthorizations: Array<string | null> = [];
  const requestedUrls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    requestedUrls.push(url);
    const path = new URL(url).pathname;
    if (path === '/events') {
      streamAuthorizations.push(new Headers(init?.headers).get('authorization'));
      return new Response('data: {"type":"ready"}\n\n');
    }
    if (path === '/v1/status') {
      return Response.json(lifecycleStatus('running'));
    }
    return Response.json({ status: 'ok', interfaceVersion: '1' });
  }) as unknown as typeof fetch;

  await callDaemonStream('/events', () => {}, {
    credentialFile,
    url: 'https://wallet.example.com',
  });

  expect(streamAuthorizations).toEqual([`Bearer ${'c'.repeat(43)}`]);
  expect(requestedUrls).toEqual([
    'https://wallet.example.com/health',
    'https://wallet.example.com/v1/status',
    'https://wallet.example.com/events',
  ]);
});

describe('ensureDaemonRunning', () => {
  test('only requires process health when an existing session is stopped', async () => {
    const requestedPaths: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPaths.push(url.pathname);
      return Response.json({ status: 'ok', interfaceVersion: '1' });
    }) as unknown as typeof fetch;

    await ensureDaemonRunning({ credentialFile: '/missing/credential' });

    expect(requestedPaths).toEqual(['/health']);
  });

  test('reports a missing local Client Credential once an auto-started daemon is reachable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
    directories.push(directory);
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = mock(() => ({
      unref() {},
    })) as unknown as typeof Bun.spawn;
    globalThis.fetch = mock(async () =>
      Response.json({ status: 'ok', interfaceVersion: '1' }),
    ) as unknown as typeof fetch;

    await expect(
      startDaemonProcess({ credentialFile: join(directory, 'missing-credential') }),
    ).resolves.toBeUndefined();
  }, 7_000);

  test('never auto-starts when an explicit endpoint is unreachable', async () => {
    const spawn = mock(() => ({
      unref() {},
    })) as unknown as typeof Bun.spawn;
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = spawn;
    globalThis.fetch = mock(async () => {
      throw new Error('Connection refused');
    }) as unknown as typeof fetch;

    await expect(ensureDaemonRunning({ url: 'https://wallet.example.com' })).rejects.toThrow(
      'Cannot connect to the explicit Cocod endpoint https://wallet.example.com; no local process was started',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});

function lifecycleStatus(state: 'stopped' | 'starting' | 'running') {
  return {
    daemon: { version: '0.0.17', interfaceVersion: '1' as const },
    wallet: null,
    seedAccess: null,
    cocoSession: { state, startedAt: null, lastFailure: null },
  };
}

async function temporaryCredentialFile(credential: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
  directories.push(directory);
  const path = join(directory, 'admin-credential');
  await writeFile(path, `${credential}\n`, { mode: 0o600 });
  return path;
}
