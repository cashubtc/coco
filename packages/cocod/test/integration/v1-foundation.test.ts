import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import {
  buildV1Routes,
  defineV1Route,
  emptyCommandRequestSchema,
  V1HttpError,
  type V1RouteDefinition,
} from '../../src/v1/http.js';
import {
  pageParameters,
  pathIdentifier,
  queryBoolean,
  queryStrings,
} from '../../src/v1/resources/shared.js';
import { namedSchema, objectNode, stringNode } from '../../src/v1/schema-nodes.js';
import { startTcpTestServer } from '../helpers/tcp.js';

const directories: string[] = [];
const servers: ReturnType<typeof startTcpTestServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

// A transport-only fixture: no Wallet resource family is registered by these tests.
const resultSchema = namedSchema<{ value: string }>(
  'TestResult',
  objectNode({ value: stringNode() }),
);
const parameters = {
  id: pathIdentifier('Test identifier'),
  ...pageParameters,
  enabled: queryBoolean('Test flag'),
  label: queryStrings('Test labels'),
};

async function listen(definitions: V1RouteDefinition[]) {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-foundation-'));
  directories.push(directory);
  const credentials = await AdministrativeCredential.loadOrBootstrap({
    credentialDirectory: directory,
  });
  const token = await loadClientCredential(join(directory, 'current', 'client'));
  const server = startTcpTestServer({
    routes: buildV1Routes(definitions, credentials),
    fetch: () => new Response(null, { status: 404 }),
  });
  servers.push(server);
  return {
    credentials,
    restrictToRead: async () => {
      const path = join(directory, 'current', 'verifier.json');
      const state = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(path, JSON.stringify({ ...state, capabilities: ['wallet:read'] }), {
        mode: 0o600,
      });
    },
    call: (path: string, options: { key?: string; body?: string; token?: string } = {}) =>
      fetch(new URL(path, server.url), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.token ?? token}`,
          ...(options.key ? { 'Idempotency-Key': options.key } : {}),
        },
        body: options.body ?? '{}',
      }),
  };
}

test('TCP path templates pass decoded parameters and the request to handlers', async () => {
  const harness = await listen([
    defineV1Route({
      method: 'POST',
      path: '/v1/test/{id}',
      capability: 'wallet:read',
      parameters,
      requestSchema: emptyCommandRequestSchema,
      responseSchema: resultSchema,
      handler: (_input, context) => ({
        value: JSON.stringify({ ...context.params, method: context.request.method }),
      }),
    }),
  ]);
  const response = await harness.call(
    '/v1/test/hello%20world?label=a&label=b&enabled=false&limit=2',
  );
  expect(response.status).toBe(200);
  expect(JSON.parse(((await response.json()) as { value: string }).value)).toEqual({
    id: 'hello world',
    offset: 0,
    limit: 2,
    enabled: false,
    label: ['a', 'b'],
    method: 'POST',
  });
});

test('parameter and body validation rejects requests before handler invocation', async () => {
  let calls = 0;
  const harness = await listen([
    defineV1Route({
      method: 'POST',
      path: '/v1/test/{id}',
      capability: 'wallet:read',
      parameters,
      requestSchema: emptyCommandRequestSchema,
      responseSchema: resultSchema,
      handler: () => {
        calls++;
        return { value: 'ok' };
      },
    }),
  ]);
  for (const [suffix, parameter] of [
    ['?limit=0', 'limit'],
    ['?limit=101', 'limit'],
    ['?offset=-1', 'offset'],
    ['?offset=9007199254740992', 'offset'],
    ['?limit=1&limit=2', 'limit'],
    ['?enabled=yes', 'enabled'],
    ['?label=', 'label'],
    ['?unknown=1', 'unknown'],
  ]) {
    const response = await harness.call(`/v1/test/id${suffix}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { parameter } },
    });
  }
  for (const body of ['{bad-json', '{"unknown":true}']) {
    expect((await harness.call('/v1/test/id', { body })).status).toBe(400);
  }
  expect(calls).toBe(0);
});

test('idempotency identity includes concrete path and normalized parameters', async () => {
  let calls = 0;
  const harness = await listen([
    defineV1Route({
      method: 'POST',
      path: '/v1/test/{id}',
      capability: 'wallet:admin',
      parameters,
      requestSchema: emptyCommandRequestSchema,
      responseSchema: resultSchema,
      idempotencyKey: 'optional',
      handler: () => ({ value: String(++calls) }),
    }),
  ]);
  const first = await harness.call('/v1/test/one', { key: 'same' });
  const replay = await harness.call('/v1/test/one?offset=0&limit=20', { key: 'same' });
  expect(await first.json()).toEqual({ value: '1' });
  expect(await replay.json()).toEqual({ value: '1' });
  expect(replay.headers.get('x-request-id')).not.toBe(first.headers.get('x-request-id'));
  for (const path of ['/v1/test/two', '/v1/test/one?limit=1', '/v1/test/one?enabled=true']) {
    const response = await harness.call(path, { key: 'same' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'idempotency_key_conflict' } });
  }
  expect(calls).toBe(1);
});

test('authorization and current availability take precedence over replay', async () => {
  let available = true;
  let calls = 0;
  const harness = await listen([
    defineV1Route({
      method: 'POST',
      path: '/v1/test',
      capability: 'wallet:admin',
      requestSchema: emptyCommandRequestSchema,
      responseSchema: resultSchema,
      idempotencyKey: 'optional',
      responseCacheControl: 'no-store',
      assertAvailable: () => {
        if (!available)
          throw new V1HttpError({
            status: 503,
            code: 'session_stopped',
            message: 'Stopped',
            retryable: false,
          });
      },
      handler: () => ({ value: String(++calls) }),
    }),
  ]);
  expect((await harness.call('/v1/test', { key: 'replay' })).status).toBe(200);
  available = false;
  const stopped = await harness.call('/v1/test', { key: 'replay' });
  expect(stopped.status).toBe(503);
  expect(stopped.headers.get('cache-control')).toBe('no-store');
  expect(await stopped.json()).toMatchObject({
    error: { code: 'session_stopped', retryable: false },
  });
  available = true;
  expect(await (await harness.call('/v1/test', { key: 'replay' })).json()).toEqual({ value: '1' });
  await harness.credentials.rotate();
  const revoked = await harness.call('/v1/test', { key: 'replay' });
  expect(revoked.status).toBe(401);
  expect(revoked.headers.get('cache-control')).toBe('no-store');
  expect(calls).toBe(1);
});

test('no-store covers authentication, validation, mapped, internal, and replay-conflict errors', async () => {
  const harness = await listen([
    defineV1Route({
      method: 'POST',
      path: '/v1/test/{id}',
      capability: 'wallet:admin',
      parameters,
      requestSchema: emptyCommandRequestSchema,
      responseSchema: resultSchema,
      idempotencyKey: 'optional',
      responseCacheControl: 'no-store',
      handler: (_input, { params }) => {
        if (params.id === 'internal') throw new Error('private failure');
        if (params.id === 'mapped')
          throw new V1HttpError({
            status: 404,
            code: 'not_found',
            message: 'Missing',
            retryable: false,
          });
        return { value: 'ok' };
      },
    }),
  ]);
  for (const [path, options, status] of [
    ['/v1/test/ok', { token: 'invalid' }, 401],
    ['/v1/test/ok', { body: '{bad-json' }, 400],
    ['/v1/test/ok?unknown=1', {}, 400],
    ['/v1/test/mapped', {}, 404],
    ['/v1/test/internal', {}, 500],
    ['/v1/test/ok', { key: 'conflict' }, 200],
    ['/v1/test/other', { key: 'conflict' }, 409],
  ] as const) {
    const response = await harness.call(path, options);
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.text()).not.toContain('private failure');
  }
  await harness.restrictToRead();
  const forbidden = await harness.call('/v1/test/ok', { key: 'conflict' });
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get('cache-control')).toBe('no-store');
});
