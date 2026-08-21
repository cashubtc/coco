import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdministrativeCredential, loadClientCredential } from './credentials.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from './routes';
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

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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

    expect(routes['/balance']).toBeUndefined();
    expect(routes['/ping']).toBeUndefined();
    expect(routes['/status']).toBeUndefined();
    expect(routes['/init']).toBeUndefined();
    expect(routes['/unlock']).toBeUndefined();
    expect(routes['/events']).toBeUndefined();
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
