import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHostLocalOperation,
  callDaemonStream,
  createV1Client,
  ensureDaemonRunning,
  startDaemonProcess,
  V1ClientError,
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

function lifecycleStatus(state: 'stopped' | 'running') {
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
