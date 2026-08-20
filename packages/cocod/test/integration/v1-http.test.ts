import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toAmount } from '@cashu/coco-core';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import { ProcessShutdownCoordinator } from '../../src/process-shutdown.js';
import { CocodRuntime, type CocodStatus } from '../../src/runtime.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from '../../src/routes.js';
import {
  buildV1FallbackHandler,
  buildV1Routes,
  createV1RouteDefinitions,
  type V1Runtime,
} from '../../src/v1/http.js';
import { deferred } from '../helpers/deferred.js';
import { createTestLogger } from '../helpers/logger.js';
import { startTcpTestServer } from '../helpers/tcp.js';
import { createLifecycleTestRouteDefinitions } from '../helpers/v1.js';

let server: ReturnType<typeof Bun.serve> | undefined;
const directories: string[] = [];

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('serves public health and authenticated structured status beside operational legacy routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-listener-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  let runtimeStatus: CocodStatus = {
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped' as const, startedAt: null, lastFailure: null },
  };
  const startCompletion = deferred<void>();
  const stopCompletion = deferred<void>();
  const runtime: V1Runtime = {
    getStatus: () => runtimeStatus,
    getRunningSession: () => null,
    initializeWallet: async (input) => {
      const requiresPassphrase = Boolean(input.passphrase);
      runtimeStatus = {
        wallet: {
          configuredAt: '2026-08-16T00:00:00.000Z',
          mintUrl: 'https://mint.example.com',
        },
        seedAccess: {
          state: requiresPassphrase ? 'locked' : 'available',
          requiresPassphrase,
        },
        cocoSession: {
          state: requiresPassphrase ? 'stopped' : 'starting',
          startedAt: null,
          lastFailure: null,
        },
      };
      return {
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        requiresPassphrase,
      };
    },
    getWalletRecoveryMaterial: async () =>
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    startSession: () => {
      runtimeStatus = {
        ...runtimeStatus,
        cocoSession: { ...runtimeStatus.cocoSession, state: 'starting' },
      };
      return {
        accepted: Promise.resolve(),
        completion: startCompletion.promise.then(() => {
          runtimeStatus = {
            ...runtimeStatus,
            seedAccess: { state: 'available', requiresPassphrase: true },
            cocoSession: {
              state: 'running',
              startedAt: '2026-08-16T00:00:01.000Z',
              lastFailure: null,
            },
          };
        }),
      };
    },
    stopSession: () => {
      runtimeStatus = {
        ...runtimeStatus,
        cocoSession: { ...runtimeStatus.cocoSession, state: 'stopping' },
      };
      return stopCompletion.promise.then(() => {
        runtimeStatus = {
          ...runtimeStatus,
          seedAccess: { state: 'locked', requiresPassphrase: true },
          cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
        };
      });
    },
  };
  const legacyRuntime = runtime as CocodRuntime;
  const legacyFallback = buildFallbackHandler(legacyRuntime, credentials);

  server = startTcpTestServer({
    routes: {
      ...buildRoutes(createRouteHandlers(legacyRuntime), legacyRuntime, credentials),
      ...buildV1Routes(createLifecycleTestRouteDefinitions(runtime, '0.0.17'), credentials),
    },
    fetch: buildV1FallbackHandler(credentials, legacyFallback),
  });

  const health = await tcpFetch(server, '/health');
  const healthMethodNotAllowed = await tcpFetch(server, '/health', undefined, 'POST', '{not-json');
  const unauthenticated = await tcpFetch(server, '/v1/status');
  const status = await tcpFetch(server, '/v1/status', plaintext);
  const unknown = await tcpFetch(server, '/v1/unknown', plaintext);
  const unsupportedQuoteType = await tcpFetch(
    server,
    '/v1/quotes/custom',
    plaintext,
    'POST',
    JSON.stringify({ amount: '25', unit: 'sat' }),
    { 'Content-Type': 'application/json' },
  );

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
  expect(unsupportedQuoteType.status).toBe(409);
  expect(await unsupportedQuoteType.json()).toEqual({
    error: {
      code: 'unsupported_behavior',
      message: 'The Quote type is unsupported',
      retryable: false,
      details: { type: 'custom' },
    },
  });

  const initialize = await tcpFetch(
    server,
    '/v1/admin/wallet/initialize',
    plaintext,
    'POST',
    JSON.stringify({ passphrase: 'correct horse' }),
    { 'Content-Type': 'application/json', 'Idempotency-Key': 'listener-initialize-1' },
  );
  expect(initialize.status).toBe(201);
  expect(initialize.headers.get('cache-control')).toBe('no-store');
  expect(await initialize.json()).toMatchObject({
    generatedMnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
    status: { cocoSession: { state: 'stopped' } },
  });

  const replay = await tcpFetch(
    server,
    '/v1/admin/wallet/initialize',
    plaintext,
    'POST',
    JSON.stringify({ passphrase: 'correct horse' }),
    { 'Content-Type': 'application/json', 'Idempotency-Key': 'listener-initialize-1' },
  );
  expect(replay.status).toBe(201);

  const recoveryMaterial = await tcpFetch(
    server,
    '/v1/admin/wallet/recovery-material',
    plaintext,
    'POST',
    JSON.stringify({ passphrase: 'correct horse' }),
    { 'Content-Type': 'application/json' },
  );
  expect(recoveryMaterial.status).toBe(200);
  expect(recoveryMaterial.headers.get('cache-control')).toBe('no-store');
  expect(await recoveryMaterial.json()).toEqual({
    mnemonic:
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  });

  const start = await tcpFetch(
    server,
    '/v1/admin/session/start',
    plaintext,
    'POST',
    JSON.stringify({ passphrase: 'correct horse' }),
    { 'Content-Type': 'application/json' },
  );
  expect(start.status).toBe(202);
  expect(await start.json()).toMatchObject({ cocoSession: { state: 'starting' } });
  startCompletion.resolve();
  await startCompletion.promise;
  await Promise.resolve();

  const stop = await tcpFetch(server, '/v1/admin/session/stop', plaintext, 'POST', '{}', {
    'Content-Type': 'application/json',
  });
  expect(stop.status).toBe(202);
  expect(await stop.json()).toMatchObject({ cocoSession: { state: 'stopping' } });
  stopCompletion.resolve();
});

test('serves Send prepare and sensitive execute results across the TCP interface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-send-listener-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  const prepared = {
    id: 'send-operation-network',
    state: 'prepared' as const,
    mintUrl: 'https://mint.example.com',
    amount: toAmount(25),
    unit: 'sat',
    method: 'default' as const,
    methodData: {},
    createdAt: 1_786_838_400_000,
    updatedAt: 1_786_838_460_000,
    needsSwap: true,
    fee: toAmount(2),
    inputAmount: toAmount(27),
    inputProofSecrets: ['must-not-cross-the-network'],
    outputData: { mustNotCrossTheNetwork: true },
  };
  const token = { mint: prepared.mintUrl, proofs: [] };
  const pending = { ...prepared, state: 'pending' as const, token };
  const prepare = mock(async () => prepared);
  const execute = mock(async () => ({ operation: pending, token }));
  const runtime = {
    getStatus: () => ({
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'available' as const, requiresPassphrase: false },
      cocoSession: {
        state: 'running' as const,
        startedAt: '2026-08-16T00:00:00.000Z',
        lastFailure: null,
      },
    }),
    getRunningSession: () => ({
      mintUrl: prepared.mintUrl,
      manager: {
        ops: { send: { prepare, execute } },
        wallet: { encodeToken: () => 'cashuBnetwork-result' },
      },
    }),
  } as unknown as V1Runtime;

  server = startTcpTestServer({
    routes: buildV1Routes(createLifecycleTestRouteDefinitions(runtime, '0.0.17'), credentials),
    fetch: buildV1FallbackHandler(credentials, async () => new Response(null, { status: 404 })),
  });

  const prepareResponse = await tcpFetch(
    server,
    '/v1/operations/send',
    plaintext,
    'POST',
    JSON.stringify({ amount: '25', unit: 'sat' }),
    { 'Content-Type': 'application/json' },
  );
  const prepareBody = await prepareResponse.json();
  const executeResponse = await tcpFetch(
    server,
    '/v1/operations/send/send-operation-network/execute',
    plaintext,
    'POST',
  );

  expect(prepareResponse.status).toBe(201);
  expect(JSON.stringify(prepareBody)).not.toContain('must-not-cross-the-network');
  expect(prepare).toHaveBeenCalledWith({
    mintUrl: 'https://mint.example.com',
    amount: '25',
    unit: 'sat',
  });
  expect(executeResponse.status).toBe(200);
  expect(executeResponse.headers.get('cache-control')).toBe('no-store');
  expect(await executeResponse.json()).toMatchObject({
    operation: { id: 'send-operation-network', state: 'pending' },
    result: { token: 'cashuBnetwork-result' },
  });
});

test('commits accepted process shutdown before graceful listener closure completes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-process-stop-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
  const runtime = await CocodRuntime.load({
    configFile: join(directory, 'state', 'config.json'),
    saltFile: join(directory, 'state', 'salt'),
  });
  const exit = mock((_code: number) => {});
  const shutdown = new ProcessShutdownCoordinator({
    closeListener: async () => {
      await server?.stop();
    },
    disposeRuntime: () => runtime.dispose(),
    cleanupProcessState: async () => {},
    flushLogs: async () => {},
    reportFailure: () => {},
    exit,
    logger: createTestLogger(),
  });
  const availability = { isAcceptingWork: () => shutdown.isAcceptingWork() };
  const legacyFallback = buildFallbackHandler(runtime, credentials, undefined, availability);

  server = startTcpTestServer({
    routes: {
      ...buildRoutes(createRouteHandlers(runtime), runtime, credentials, undefined, availability),
      ...buildV1Routes(
        createV1RouteDefinitions(runtime, '0.0.17', shutdown),
        credentials,
        undefined,
        availability,
      ),
    },
    fetch: buildV1FallbackHandler(credentials, legacyFallback),
  });

  const response = await tcpFetch(server, '/v1/admin/process/stop', plaintext, 'POST', '{}', {
    'Content-Type': 'application/json',
    Connection: 'close',
  });

  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ status: 'stopping' });
  expect(await shutdown.request('http_stop')).toBe(0);
  expect(exit).toHaveBeenCalledWith(0);
  await expect(tcpFetch(server, '/health')).rejects.toThrow();
});

function tcpFetch(
  listener: ReturnType<typeof Bun.serve>,
  path: string,
  credential?: string,
  method = 'GET',
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL(path, listener.url), {
    method,
    headers: {
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...extraHeaders,
    },
    body,
  } as RequestInit);
}
