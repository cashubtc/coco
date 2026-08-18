import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AdministrativeCredential,
  loadClientCredential,
  type ClientCapability,
} from '../../src/credentials.js';
import type { CocodRuntime, CocodStatus } from '../../src/runtime.js';
import type { AppLogger } from '../../src/utils/logger.js';
import {
  buildV1Routes,
  createV1RouteDefinitions,
  defineV1Route,
  type RuntimeSchema,
} from '../../src/v1/http.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('v1 HTTP route interface', () => {
  test('declares health and status with their runtime schemas and capabilities', () => {
    const routes = createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17');

    expect(
      routes.map(({ method, path, capability, requestSchema, responseSchema }) => ({
        method,
        path,
        capability,
        requestSchema: requestSchema.name,
        responseSchema: responseSchema.name,
      })),
    ).toEqual([
      {
        method: 'GET',
        path: '/health',
        capability: null,
        requestSchema: 'NoBody',
        responseSchema: 'Health',
      },
      {
        method: 'GET',
        path: '/v1/status',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'LifecycleStatus',
      },
    ]);
  });

  test('returns the documented status resource in every Coco Session state', async () => {
    const credential = await createCredential();
    const states = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const;

    for (const state of states) {
      const status = configuredStatus(state);
      const routes = buildV1Routes(
        createV1RouteDefinitions(statusRuntime(status), '0.0.17'),
        credential.credentials,
      );
      const response = await routes['/v1/status']!.GET!(
        authorizedRequest('/v1/status', credential.plaintext),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toStartWith('application/json');
      expect(response.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await response.json()).toEqual({
        daemon: { version: '0.0.17', interfaceVersion: '1' },
        wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
        seedAccess: { state: 'available', requiresPassphrase: false },
        cocoSession: {
          state,
          startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
          lastFailure:
            state === 'failed'
              ? {
                  code: 'session_start_failed',
                  message: 'Coco Session failed to start',
                  occurredAt: '2026-08-16T00:00:02.000Z',
                }
              : null,
        },
      });
    }
  });

  test('returns null Wallet and Seed Access when no Wallet is configured', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('returns a configured Wallet with locked Seed Access and no running session', async () => {
    const credential = await createCredential();
    const status: CocodStatus = {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(status), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('returns stable authentication and capability errors without legacy envelopes', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/status']!.GET!(
      new Request('http://localhost/v1/status'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
    expect(await unauthenticated.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: 'A valid Client Credential is required',
        retryable: false,
      },
    });

    const invalidCredential = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', 'x'.repeat(43)),
    );
    expect(invalidCredential.status).toBe(401);
    expect(await invalidCredential.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });

    await setCapabilities(credential.verifierFile, ['wallet:admin']);
    const forbidden = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'The Client Credential lacks the required capability',
        retryable: false,
      },
    });
  });

  test('rejects a route declaration that leaves a /v1 resource unauthenticated', async () => {
    const credential = await createCredential();
    const route = defineV1Route({
      method: 'GET',
      path: '/v1/public-by-mistake',
      capability: null,
      requestSchema: {
        name: 'NoBody',
        jsonSchema: { type: 'null' },
        parse: () => null,
      },
      responseSchema: {
        name: 'Ok',
        jsonSchema: { type: 'object' },
        parse: () => ({ ok: true }),
      },
      handler: async () => ({ ok: true }),
    });

    expect(() => buildV1Routes([route], credential.credentials)).toThrow(
      'V1 route GET /v1/public-by-mistake must require a capability',
    );
  });

  test('validates input and output and maps failures to stable errors', async () => {
    const credential = await createCredential();
    const requestSchema: RuntimeSchema<{ label: string }> = {
      name: 'TestRequest',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.label !== 'string') {
          throw new Error('label must be a string');
        }
        return { label: value.label };
      },
    };
    const responseSchema: RuntimeSchema<{ accepted: boolean }> = {
      name: 'TestResponse',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['accepted'],
        properties: { accepted: { type: 'boolean' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.accepted !== 'boolean') {
          throw new Error('accepted must be a boolean');
        }
        return { accepted: value.accepted };
      },
    };
    const route = defineV1Route<{ label: string }, { accepted: boolean }>({
      method: 'POST',
      path: '/v1/test',
      capability: 'wallet:admin',
      requestSchema,
      responseSchema,
      handler: async () => ({ accepted: true }),
    });
    const routes = buildV1Routes([route], credential.credentials);

    const malformed = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.plaintext}` },
        body: '{not-json',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request body is not valid JSON',
        retryable: false,
      },
    });

    const invalid = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 21 }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_request', retryable: false },
    });

    const invalidOutput = buildV1Routes(
      [{ ...route, handler: async () => ({ accepted: 'yes' }) }],
      credential.credentials,
    );
    const failed = await invalidOutput['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'safe' }),
      }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed',
        retryable: false,
      },
    });
  });

  test('redacts sensitive input fields in centralized request logs', async () => {
    const credential = await createCredential();
    const debug = mock((_event: string, _fields?: unknown) => {});
    let logger: AppLogger;
    logger = {
      error: mock(() => {}),
      warn: mock(() => {}),
      info: mock(() => {}),
      debug,
      child: mock(() => logger),
      flush: mock(async () => {}),
    } as unknown as AppLogger;
    const requestSchema: RuntimeSchema<{ passphrase: string; label: string }> = {
      name: 'SensitiveRequest',
      jsonSchema: { type: 'object' },
      parse(value) {
        if (!isRecord(value) || typeof value.passphrase !== 'string') {
          throw new Error('invalid');
        }
        return { passphrase: value.passphrase, label: String(value.label) };
      },
    };
    const responseSchema: RuntimeSchema<{ ok: true }> = {
      name: 'Ok',
      jsonSchema: { type: 'object' },
      parse: () => ({ ok: true }),
    };
    const routes = buildV1Routes(
      [
        defineV1Route({
          method: 'POST',
          path: '/v1/sensitive',
          capability: 'wallet:admin',
          requestSchema,
          responseSchema,
          handler: async () => ({ ok: true }),
        }),
      ],
      credential.credentials,
      logger,
    );

    await routes['/v1/sensitive']!.POST!(
      new Request('http://localhost/v1/sensitive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ passphrase: 'open sesame', label: 'visible' }),
      }),
    );

    expect(JSON.stringify(debug.mock.calls)).not.toContain('open sesame');
    expect(debug).toHaveBeenCalledWith('request.received', {
      input: { passphrase: '[REDACTED]', label: 'visible' },
    });
  });
});

function statusRuntime(status: CocodStatus): CocodRuntime {
  return { getStatus: () => status } as CocodRuntime;
}

function unconfiguredStatus(): CocodStatus {
  return {
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  };
}

function configuredStatus(state: CocodStatus['cocoSession']['state']): CocodStatus {
  return {
    wallet: {
      configuredAt: '2026-08-16T00:00:00.000Z',
      mintUrl: 'https://mint.example.com',
    },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: {
      state,
      startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
      lastFailure:
        state === 'failed'
          ? {
              code: 'session_start_failed',
              message: 'Coco Session failed to start',
              occurredAt: '2026-08-16T00:00:02.000Z',
            }
          : null,
    },
  };
}

async function createCredential(): Promise<{
  credentials: AdministrativeCredential;
  plaintext: string;
  verifierFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-http-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  return {
    credentials,
    plaintext: await loadClientCredential(join(currentDirectory, 'client')),
    verifierFile: join(currentDirectory, 'verifier.json'),
  };
}

async function setCapabilities(path: string, capabilities: ClientCapability[]): Promise<void> {
  const state = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  state.capabilities = capabilities;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

function authorizedRequest(path: string, credential: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
