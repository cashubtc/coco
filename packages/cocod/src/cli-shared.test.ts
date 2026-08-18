import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
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
  globalThis.fetch = mock(async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get('authorization'));
    return Response.json({ output: 'UNLOCKED' });
  }) as unknown as typeof fetch;

  await callDaemon('/status', { credentialFile });

  expect(authorizations).toEqual([`Bearer ${'a'.repeat(43)}`]);
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

test('streaming requests attach the file-backed bearer credential', async () => {
  const credentialFile = await temporaryCredentialFile('c'.repeat(43));
  const streamAuthorizations: Array<string | null> = [];
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === '/events') {
      streamAuthorizations.push(new Headers(init?.headers).get('authorization'));
      return new Response('data: {"type":"ready"}\n\n');
    }
    if (path === '/status') {
      return Response.json({ output: 'UNLOCKED' });
    }
    return Response.json({ output: 'pong' });
  }) as unknown as typeof fetch;

  await callDaemonStream('/events', () => {}, { credentialFile });

  expect(streamAuthorizations).toEqual([`Bearer ${'c'.repeat(43)}`]);
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
});

async function temporaryCredentialFile(credential: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-cli-credential-'));
  directories.push(directory);
  const path = join(directory, 'admin-credential');
  await writeFile(path, `${credential}\n`, { mode: 0o600 });
  return path;
}
