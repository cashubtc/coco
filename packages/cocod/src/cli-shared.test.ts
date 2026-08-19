import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertHostLocalOperation,
  callDaemon,
  callDaemonStream,
  ensureDaemonRunning,
  startDaemonProcess,
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

test('normal protected requests attach the file-backed bearer credential', async () => {
  const credentialFile = await temporaryCredentialFile('a'.repeat(43));
  const authorizations: Array<string | null> = [];
  const requestedUrls: string[] = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    requestedUrls.push(input instanceof Request ? input.url : input.toString());
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ output: 'UNLOCKED' });
  }) as unknown as typeof fetch;

  await callDaemon('/status', { credentialFile, url: 'https://wallet.example.com' });

  expect(authorizations).toEqual([`Bearer ${'a'.repeat(43)}`]);
  expect(requestedUrls).toEqual(['https://wallet.example.com/status']);
});

test('the liveness request remains credential-free', async () => {
  const authorizations: Array<string | null> = [];
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ output: 'pong' });
  }) as unknown as typeof fetch;

  await callDaemon('/ping', { credentialFile: '/missing/credential' });

  expect(authorizations).toEqual([null]);
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
    if (path === '/status') {
      return Response.json({ output: 'UNLOCKED' });
    }
    return Response.json({ output: 'pong' });
  }) as unknown as typeof fetch;

  await callDaemonStream('/events', () => {}, {
    credentialFile,
    url: 'https://wallet.example.com',
  });

  expect(streamAuthorizations).toEqual([`Bearer ${'c'.repeat(43)}`]);
  expect(requestedUrls).toEqual([
    'https://wallet.example.com/ping',
    'https://wallet.example.com/status',
    'https://wallet.example.com/events',
  ]);
});

describe('ensureDaemonRunning', () => {
  test('waits for an already-running daemon to finish startup', async () => {
    const credentialFile = await temporaryCredentialFile('b'.repeat(43));
    const requestedPaths: string[] = [];
    const statusAuthorizations: Array<string | null> = [];
    let statusRequests = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPaths.push(url.pathname);

      if (url.pathname === '/ping') {
        return Response.json({ output: 'pong' });
      }

      statusRequests += 1;
      statusAuthorizations.push(new Headers(init?.headers).get('authorization'));
      return Response.json({ output: statusRequests === 1 ? 'STARTING' : 'UNLOCKED' });
    }) as unknown as typeof fetch;

    await ensureDaemonRunning({ credentialFile });

    expect(statusRequests).toBe(2);
    expect(requestedPaths).toEqual(['/ping', '/status', '/status']);
    expect(statusAuthorizations).toEqual([`Bearer ${'b'.repeat(43)}`, `Bearer ${'b'.repeat(43)}`]);
  });

  test('reports a missing local Client Credential for an existing daemon', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
    directories.push(directory);
    globalThis.fetch = mock(async () =>
      Response.json({ output: 'pong' }),
    ) as unknown as typeof fetch;

    await expect(
      ensureDaemonRunning({ credentialFile: join(directory, 'missing-credential') }),
    ).rejects.toThrow('Cocod Client Credential file is missing');
  });

  test('reports a missing local Client Credential once an auto-started daemon is reachable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
    directories.push(directory);
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = mock(() => ({
      unref() {},
    })) as unknown as typeof Bun.spawn;
    globalThis.fetch = mock(async () =>
      Response.json({ output: 'pong' }),
    ) as unknown as typeof fetch;

    await expect(
      startDaemonProcess({ credentialFile: join(directory, 'missing-credential') }),
    ).rejects.toThrow('Cocod Client Credential file is missing');
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

async function temporaryCredentialFile(credential: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
  directories.push(directory);
  const path = join(directory, 'admin-credential');
  await writeFile(path, `${credential}\n`, { mode: 0o600 });
  return path;
}
