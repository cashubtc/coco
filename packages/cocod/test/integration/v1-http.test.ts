import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import type { CocodRuntime } from '../../src/runtime.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from '../../src/routes.js';
import {
  buildV1FallbackHandler,
  buildV1Routes,
  createV1RouteDefinitions,
} from '../../src/v1/http.js';

let server: ReturnType<typeof Bun.serve> | undefined;
const directories: string[] = [];

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('serves public health and authenticated structured status beside legacy routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-listener-'));
  directories.push(directory);
  const socketPath = join(directory, 'cocod.sock');
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  const runtime = {
    getStatus: () => ({
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped' as const, startedAt: null, lastFailure: null },
    }),
  } as CocodRuntime;
  const legacyFallback = buildFallbackHandler(runtime, credentials);

  server = Bun.serve({
    unix: socketPath,
    routes: {
      ...buildRoutes(createRouteHandlers(runtime), runtime, credentials),
      ...buildV1Routes(createV1RouteDefinitions(runtime, '0.0.17'), credentials),
    },
    fetch: buildV1FallbackHandler(credentials, legacyFallback),
  });

  const health = await unixFetch(socketPath, '/health');
  const healthMethodNotAllowed = await unixFetch(
    socketPath,
    '/health',
    undefined,
    'POST',
    '{not-json',
  );
  const unauthenticated = await unixFetch(socketPath, '/v1/status');
  const status = await unixFetch(socketPath, '/v1/status', plaintext);
  const unknown = await unixFetch(socketPath, '/v1/unknown', plaintext);
  const legacy = await unixFetch(socketPath, '/status', plaintext);

  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({ status: 'ok', interfaceVersion: '1' });
  expect(healthMethodNotAllowed.status).toBe(405);
  expect(healthMethodNotAllowed.headers.get('allow')).toBe('GET');
  expect(await healthMethodNotAllowed.json()).toEqual({
    error: {
      code: 'method_not_allowed',
      message: 'The requested method is not allowed',
      retryable: false,
    },
  });
  expect(unauthenticated.status).toBe(401);
  expect(await unauthenticated.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({
    daemon: { version: '0.0.17', interfaceVersion: '1' },
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  });
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({
    error: {
      code: 'not_found',
      message: 'The requested resource does not exist',
      retryable: false,
    },
  });
  expect(await legacy.json()).toEqual({ output: 'UNINITIALIZED' });
});

function unixFetch(
  socketPath: string,
  path: string,
  credential?: string,
  method = 'GET',
  body?: string,
): Promise<Response> {
  return fetch(`http://localhost${path}`, {
    unix: socketPath,
    method,
    headers: credential ? { Authorization: `Bearer ${credential}` } : undefined,
    body,
  } as RequestInit);
}
