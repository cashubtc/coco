import { expect, test } from 'bun:test';

import {
  createV1RouteMetadata,
  healthSchema,
  initializeWalletRequestSchema,
  initializeWalletResponseSchema,
  lifecycleStatusSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  v1ErrorSchema,
} from '../../src/v1/http.js';
import { generateV1InterfaceDescription } from '../../src/v1/interface-description.js';

test('the generated lifecycle interface description comes from the runtime schemas', async () => {
  const generated = generateV1InterfaceDescription(createV1RouteMetadata(), '0.0.17');
  const checkedIn = JSON.parse(
    await Bun.file(new URL('../../docs/lifecycle-api-v1.json', import.meta.url)).text(),
  ) as unknown;

  expect(checkedIn).toEqual(generated);
  expect(generated.schemas).toEqual({
    Error: v1ErrorSchema.jsonSchema,
    Health: healthSchema.jsonSchema,
    LifecycleStatus: lifecycleStatusSchema.jsonSchema,
    InitializeWalletRequest: initializeWalletRequestSchema.jsonSchema,
    InitializeWalletResponse: initializeWalletResponseSchema.jsonSchema,
    StartSessionRequest: startSessionRequestSchema.jsonSchema,
    StopSessionRequest: stopSessionRequestSchema.jsonSchema,
  });
  expect(generated.routes).toEqual([
    {
      method: 'GET',
      path: '/health',
      capability: null,
      requestSchema: null,
      responseSchema: 'Health',
      errorSchema: 'Error',
      successStatuses: [200],
      idempotencyKey: null,
    },
    {
      method: 'GET',
      path: '/v1/status',
      capability: 'wallet:read',
      requestSchema: null,
      responseSchema: 'LifecycleStatus',
      errorSchema: 'Error',
      successStatuses: [200],
      idempotencyKey: null,
    },
    {
      method: 'POST',
      path: '/v1/admin/wallet/initialize',
      capability: 'wallet:admin',
      requestSchema: 'InitializeWalletRequest',
      responseSchema: 'InitializeWalletResponse',
      errorSchema: 'Error',
      successStatuses: [201, 202],
      idempotencyKey: 'optional',
    },
    {
      method: 'POST',
      path: '/v1/admin/session/start',
      capability: 'wallet:admin',
      requestSchema: 'StartSessionRequest',
      responseSchema: 'LifecycleStatus',
      errorSchema: 'Error',
      successStatuses: [200, 202],
      idempotencyKey: 'optional',
    },
    {
      method: 'POST',
      path: '/v1/admin/session/stop',
      capability: 'wallet:admin',
      requestSchema: 'StopSessionRequest',
      responseSchema: 'LifecycleStatus',
      errorSchema: 'Error',
      successStatuses: [200, 202],
      idempotencyKey: 'optional',
    },
  ]);

  expect(generated.schemas.LifecycleStatus).toHaveProperty('oneOf');
  expect(JSON.stringify(generated.schemas.LifecycleStatus)).toContain(
    '^\\\\d{4}-\\\\d{2}-\\\\d{2}T',
  );

  const cocoSession = { state: 'stopped', startedAt: null, lastFailure: null };
  expect(() =>
    lifecycleStatusSchema.parse({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: null,
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession,
    }),
  ).toThrow();
  expect(() =>
    lifecycleStatusSchema.parse({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: { configuredAt: '2026-08-16T00:00:00Z' },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession,
    }),
  ).toThrow();
});
