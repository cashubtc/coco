import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Manager } from '@cashu/coco-core';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import { CocodRuntime, type RunningCocoSession } from '../../src/runtime.js';
import { CocoSessionStartupError } from '../../src/utils/wallet.js';
import { buildV1Routes, createV1RouteDefinitions } from '../../src/v1/http.js';
import { deferred } from '../helpers/deferred.js';
import { createTestLogger } from '../helpers/logger.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

test('real lifecycle routes serialize concurrent start and stop during startup', async () => {
  const harness = await createHarness();
  const sessionReady = deferred<RunningCocoSession>();
  const initializeSession = mock(async () => sessionReady.promise);
  const runtime = await CocodRuntime.load({ ...harness.paths, initializeSession });
  const routes = buildV1Routes(createV1RouteDefinitions(runtime, '0.0.17'), harness.credentials);

  const initialize = await routes['/v1/admin/wallet/initialize']!.POST!(
    request(
      '/v1/admin/wallet/initialize',
      harness.plaintext,
      { passphrase: 'correct horse' },
      'initialize-1',
    ),
  );
  const initializeBody = (await initialize.json()) as { generatedMnemonic: string };
  expect(initialize.status).toBe(201);
  expect(initialize.headers.get('cache-control')).toBe('no-store');
  expect(initializeBody.generatedMnemonic.split(' ')).toHaveLength(24);
  expect(await Bun.file(harness.paths.configFile).text()).not.toContain(
    initializeBody.generatedMnemonic,
  );

  const firstStart = routes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  const concurrentStart = routes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  const [firstStartResponse, concurrentStartResponse] = await Promise.all([
    firstStart,
    concurrentStart,
  ]);
  expect(firstStartResponse.status).toBe(202);
  expect(concurrentStartResponse.status).toBe(202);
  expect(initializeSession).toHaveBeenCalledTimes(1);
  expect(runtime.getStatus().cocoSession.state).toBe('starting');

  const stopping = await routes['/v1/admin/session/stop']!.POST!(
    request('/v1/admin/session/stop', harness.plaintext, {}),
  );
  expect(stopping.status).toBe(202);
  expect(runtime.getStatus().cocoSession.state).toBe('stopping');

  const session = fakeSession();
  sessionReady.resolve(session);
  await runtime.stopSession();
  expect(session.manager.dispose).toHaveBeenCalledTimes(1);
  expect(runtime.getStatus().seedAccess).toEqual({
    state: 'locked',
    requiresPassphrase: true,
  });
});

test('real lifecycle routes permit retry after confirmed startup cleanup', async () => {
  const harness = await createHarness();
  const failureObserved = deferred<void>();
  const initializeSession = mock(async () => {
    if (initializeSession.mock.calls.length === 1) {
      throw new Error('repository unavailable');
    }
    return fakeSession();
  });
  const runtime = await CocodRuntime.load({ ...harness.paths, initializeSession });
  const routes = buildV1Routes(
    createV1RouteDefinitions(
      runtime,
      '0.0.17',
      testLogger(() => failureObserved.resolve()),
    ),
    harness.credentials,
  );
  await routes['/v1/admin/wallet/initialize']!.POST!(
    request('/v1/admin/wallet/initialize', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );

  const first = await routes['/v1/admin/session/start']!.POST!(
    request(
      '/v1/admin/session/start',
      harness.plaintext,
      { passphrase: 'correct horse' },
      'start-attempt-1',
    ),
  );
  expect(first.status).toBe(202);
  await failureObserved.promise;
  expect(runtime.getStatus().cocoSession.lastFailure).toMatchObject({
    code: 'session_start_failed',
  });

  const retry = await routes['/v1/admin/session/start']!.POST!(
    request(
      '/v1/admin/session/start',
      harness.plaintext,
      { passphrase: 'correct horse' },
      'start-attempt-2',
    ),
  );
  expect(retry.status).toBe(202);
  await runtime.startSession().completion;
  expect(runtime.getStatus().cocoSession.state).toBe('running');
  expect(initializeSession).toHaveBeenCalledTimes(2);
});

test('real lifecycle routes quarantine unconfirmed startup cleanup', async () => {
  const harness = await createHarness();
  const failureObserved = deferred<void>();
  const runtime = await CocodRuntime.load({
    ...harness.paths,
    initializeSession: async () => {
      throw new CocoSessionStartupError(
        'startup cleanup failed',
        'unconfirmed',
        new Error('dispose failed'),
      );
    },
  });
  const routes = buildV1Routes(
    createV1RouteDefinitions(
      runtime,
      '0.0.17',
      testLogger(() => failureObserved.resolve()),
    ),
    harness.credentials,
  );
  await routes['/v1/admin/wallet/initialize']!.POST!(
    request('/v1/admin/wallet/initialize', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );

  const accepted = await routes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  expect(accepted.status).toBe(202);
  await failureObserved.promise;
  expect(runtime.getStatus().cocoSession.state).toBe('failed');

  const blocked = await routes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  expect(blocked.status).toBe(503);
  expect(await blocked.json()).toMatchObject({
    error: { code: 'session_restart_required', retryable: false },
  });
});

test('lifecycle routes report unattended and protected Wallet restart states', async () => {
  const unattended = await createHarness();
  const initialRuntime = await CocodRuntime.load({
    ...unattended.paths,
    initializeSession: async () => fakeSession(),
  });
  const initialRoutes = buildV1Routes(
    createV1RouteDefinitions(initialRuntime, '0.0.17'),
    unattended.credentials,
  );
  const initialized = await initialRoutes['/v1/admin/wallet/initialize']!.POST!(
    request('/v1/admin/wallet/initialize', unattended.plaintext, {}),
  );
  expect(initialized.status).toBe(202);
  await initialRuntime.startSession().completion;
  await initialRuntime.stopSession();

  const unattendedReady = deferred<RunningCocoSession>();
  const restartedUnattended = await CocodRuntime.load({
    ...unattended.paths,
    initializeSession: async () => unattendedReady.promise,
  });
  const unattendedRoutes = buildV1Routes(
    createV1RouteDefinitions(restartedUnattended, '0.0.17'),
    unattended.credentials,
  );
  const available = await unattendedRoutes['/v1/status']!.GET!(
    getRequest('/v1/status', unattended.plaintext),
  );
  expect(await available.json()).toMatchObject({
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: { state: 'stopped' },
  });
  const unattendedStart = restartedUnattended.startSession();
  const starting = await unattendedRoutes['/v1/status']!.GET!(
    getRequest('/v1/status', unattended.plaintext),
  );
  expect(await starting.json()).toMatchObject({ cocoSession: { state: 'starting' } });
  unattendedReady.resolve(fakeSession());
  await unattendedStart.completion;

  const protectedHarness = await createHarness();
  const protectedInitial = await CocodRuntime.load(protectedHarness.paths);
  const protectedInitialRoutes = buildV1Routes(
    createV1RouteDefinitions(protectedInitial, '0.0.17'),
    protectedHarness.credentials,
  );
  await protectedInitialRoutes['/v1/admin/wallet/initialize']!.POST!(
    request('/v1/admin/wallet/initialize', protectedHarness.plaintext, {
      passphrase: 'correct horse',
    }),
  );

  const protectedReady = deferred<RunningCocoSession>();
  const restartedProtected = await CocodRuntime.load({
    ...protectedHarness.paths,
    initializeSession: async () => protectedReady.promise,
  });
  const protectedRoutes = buildV1Routes(
    createV1RouteDefinitions(restartedProtected, '0.0.17'),
    protectedHarness.credentials,
  );
  const locked = await protectedRoutes['/v1/status']!.GET!(
    getRequest('/v1/status', protectedHarness.plaintext),
  );
  expect(await locked.json()).toMatchObject({
    seedAccess: { state: 'locked', requiresPassphrase: true },
    cocoSession: { state: 'stopped' },
  });
  const protectedStart = await protectedRoutes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', protectedHarness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  expect(protectedStart.status).toBe(202);
  protectedReady.resolve(fakeSession());
  await restartedProtected.startSession().completion;
});

test('a stop disposal failure is exposed only as safe failed lifecycle status', async () => {
  const harness = await createHarness();
  const dispose = deferred<void>();
  const failureObserved = deferred<void>();
  const runtime = await CocodRuntime.load({
    ...harness.paths,
    initializeSession: async () => fakeSession(() => dispose.promise),
  });
  const routes = buildV1Routes(
    createV1RouteDefinitions(
      runtime,
      '0.0.17',
      testLogger(() => failureObserved.resolve()),
    ),
    harness.credentials,
  );
  await routes['/v1/admin/wallet/initialize']!.POST!(
    request('/v1/admin/wallet/initialize', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  await routes['/v1/admin/session/start']!.POST!(
    request('/v1/admin/session/start', harness.plaintext, {
      passphrase: 'correct horse',
    }),
  );
  await runtime.startSession().completion;

  const stopping = await routes['/v1/admin/session/stop']!.POST!(
    request('/v1/admin/session/stop', harness.plaintext, {}),
  );
  expect(stopping.status).toBe(202);
  dispose.reject(new Error('sensitive repository connection failed'));
  await failureObserved.promise;

  const status = await routes['/v1/status']!.GET!(getRequest('/v1/status', harness.plaintext));
  const body = await status.json();
  expect(body).toMatchObject({
    cocoSession: {
      state: 'failed',
      lastFailure: {
        code: 'session_stop_failed',
        message: 'Coco Session failed to stop cleanly',
      },
    },
  });
  expect(JSON.stringify(body)).not.toContain('sensitive repository connection failed');
});

async function createHarness(): Promise<{
  paths: { configFile: string; saltFile: string };
  credentials: AdministrativeCredential;
  plaintext: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-lifecycle-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  return {
    paths: {
      configFile: join(directory, 'state', 'config.json'),
      saltFile: join(directory, 'state', 'salt'),
    },
    credentials,
    plaintext: await loadClientCredential(join(credentialDirectory, 'current', 'client')),
  };
}

function request(
  path: string,
  credential: string,
  body: unknown,
  idempotencyKey?: string,
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function getRequest(path: string, credential: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

function fakeSession(dispose: () => Promise<void> = async () => {}): RunningCocoSession {
  return {
    manager: { dispose: mock(dispose) } as unknown as Manager,
    mintUrl: 'https://mint.example.com',
    npcAccount: {} as RunningCocoSession['npcAccount'],
  };
}

function testLogger(onFailure: () => void) {
  return createTestLogger({
    error: mock((event: string) => {
      if (event === 'lifecycle.transition_failed') {
        onFailure();
      }
    }),
  });
}
