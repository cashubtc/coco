import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Manager } from '@cashu/coco-core';

import { AdministrativeCredential, loadClientCredential } from './credentials.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from './routes';
import { startTcpTestServer } from '../test/helpers/tcp.js';
import type { AppLogger } from './utils/logger.js';
import { type CocodRuntime, type CocodStatus, type RunningCocoSession } from './runtime';

function fakeRuntime(
  status: CocodStatus,
  session: RunningCocoSession | null = null,
  overrides: Partial<CocodRuntime> = {},
): CocodRuntime {
  return {
    getStatus: () => status,
    getRunningSession: () => session,
    ...overrides,
  } as unknown as CocodRuntime;
}

function uninitializedRuntime(overrides: Partial<CocodRuntime> = {}): CocodRuntime {
  return fakeRuntime(
    {
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    },
    null,
    overrides,
  );
}

function runningRuntime(manager?: unknown, npcAccount: unknown = {}): CocodRuntime {
  const fakeManager = (manager ?? {}) as Manager;
  const fakeNpcAccount = npcAccount as import('coco-cashu-plugin-npc').NPCAccountApi;
  return fakeRuntime(
    {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession: {
        state: 'running',
        startedAt: '2026-08-16T00:00:01.000Z',
        lastFailure: null,
      },
    },
    {
      manager: fakeManager,
      mintUrl: 'https://mint.example.com',
      npcAccount: fakeNpcAccount,
    },
  );
}

function credentialPaths(directory: string): {
  credentialDirectory: string;
  verifierFile: string;
  clientCredentialFile: string;
} {
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  return {
    credentialDirectory,
    verifierFile: join(currentDirectory, 'verifier.json'),
    clientCredentialFile: join(currentDirectory, 'client'),
  };
}

describe('routes', () => {
  test('does not expose superseded lifecycle command routes', () => {
    const routes = createRouteHandlers(uninitializedRuntime());

    expect(routes['/ping']).toBeUndefined();
    expect(routes['/status']).toBeUndefined();
    expect(routes['/init']).toBeUndefined();
    expect(routes['/unlock']).toBeUndefined();
  });

  test('does not expose operational routes superseded by v1 resources', () => {
    const routes = createRouteHandlers(uninitializedRuntime());

    expect(Object.keys(routes).toSorted()).toEqual(['/npc/address', '/npc/username']);
  });

  test('rejects a protected route without a bearer credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-auth-'));
    try {
      const credentials = await AdministrativeCredential.loadOrBootstrap(
        credentialPaths(directory),
      );
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials);

      const response = await routes['/npc/address']!.GET!(
        new Request('http://localhost/npc/address'),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('serves authenticated legacy NPC routes on the shared TCP listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-tcp-npc-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      const runtime = runningRuntime(undefined, {
        getInfo: async () => ({ name: 'satoshi', pubkey: 'unused' }),
      });
      server = startTcpTestServer({
        routes: buildRoutes(createRouteHandlers(runtime), runtime, credentials),
        fetch: buildFallbackHandler(runtime, credentials),
      });

      const authorized = await fetch(new URL('/npc/address', server.url), {
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      const unauthorized = await fetch(new URL('/npc/address', server.url));

      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toEqual({ output: 'satoshi@npubx.cash' });
      expect(unauthorized.status).toBe(401);
    } finally {
      await server?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('returns a generic forbidden response when a capability is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-capability-'));
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      const state = JSON.parse(await readFile(paths.verifierFile, 'utf8')) as {
        capabilities: string[];
      };
      state.capabilities = ['wallet:read'];
      await writeFile(paths.verifierFile, JSON.stringify(state), { mode: 0o600 });
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials);

      const response = await routes['/npc/username']!.POST!(
        new Request('http://localhost/npc/username', {
          method: 'POST',
          headers: { Authorization: `Bearer ${plaintext}` },
          body: '{}',
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not include bearer credentials or authorization headers in route logs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-redaction-'));
    try {
      const credentials = await AdministrativeCredential.loadOrBootstrap(
        credentialPaths(directory),
      );
      const entries: unknown[] = [];
      const logger = {
        child: () => logger,
        debug: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        error: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        info: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        log: (_level: string, message: string, ...meta: unknown[]) =>
          entries.push([message, ...meta]),
        warn: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        flush: async () => {},
      } as AppLogger;
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials, logger);
      const presentedCredential = 'z'.repeat(43);

      const response = await routes['/npc/address']!.GET!(
        new Request('http://localhost/npc/address', {
          headers: { Authorization: `Bearer ${presentedCredential}` },
        }),
      );

      const logged = JSON.stringify(entries);
      expect(response.status).toBe(401);
      expect(logged).not.toContain(presentedCredential);
      expect(logged.toLowerCase()).not.toContain('authorization');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('removes legacy /stop and rejects new legacy work during process shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-shutdown-'));
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      const runtime = uninitializedRuntime();
      const definitions = createRouteHandlers(runtime);
      const routes = buildRoutes(definitions, runtime, credentials, undefined, {
        isAcceptingWork: () => false,
      });

      const response = await routes['/npc/address']!.GET!(
        new Request('http://localhost/npc/address', {
          headers: { Authorization: `Bearer ${plaintext}` },
        }),
      );

      expect(definitions['/stop']).toBeUndefined();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Daemon is shutting down' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
