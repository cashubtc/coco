import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHostLocalOperation,
  createV1Client,
  DEFAULT_SESSION_TRANSITION_TIMEOUT_MS,
  ensureDaemonRunning,
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

test('event watching authenticates and parses frames split across chunks', async () => {
  const credentialFile = await temporaryCredentialFile('c'.repeat(43));
  const authorizations: Array<string | null> = [];
  const historyEvent = {
    type: 'mint.updated',
    timestamp: '2026-10-29T12:00:00.000Z',
    data: { mintUrl: 'https://mint.example.com' },
  };
  const encoded = `: connected\n\ndata: ${JSON.stringify(historyEvent)}\n\n: keep-alive\n\n`;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    expect(new URL(input instanceof Request ? input.url : input.toString()).pathname).toBe(
      '/v1/events',
    );
    const bytes = new TextEncoder().encode(encoded);
    return new Response(
      new ReadableStream({
        start(controller) {
          // Split inside the event frame to exercise buffering across reads.
          controller.enqueue(bytes.slice(0, 30));
          controller.enqueue(bytes.slice(30));
          controller.close();
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  }) as unknown as typeof fetch;

  const events: unknown[] = [];
  await createV1Client({ credentialFile, url: 'https://wallet.example.com' }).watchEvents((event) =>
    events.push(event),
  );

  expect(authorizations).toEqual([`Bearer ${'c'.repeat(43)}`]);
  expect(events).toEqual([historyEvent]);
});

test('event watching reports v1 errors from the stream request', async () => {
  const credentialFile = await temporaryCredentialFile('c'.repeat(43));
  globalThis.fetch = mock(async () =>
    Response.json(
      {
        error: { code: 'wallet_locked', message: 'Wallet Seed Access is locked', retryable: false },
      },
      { status: 423 },
    ),
  ) as unknown as typeof fetch;

  const watching = createV1Client({
    credentialFile,
    url: 'https://wallet.example.com',
  }).watchEvents(() => {});

  await expect(watching).rejects.toBeInstanceOf(V1ClientError);
  await expect(watching).rejects.toMatchObject({ status: 423, code: 'wallet_locked' });
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
