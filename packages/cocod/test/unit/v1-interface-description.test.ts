import { expect, test } from 'bun:test';

import {
  balancesSchema,
  createV1RouteMetadata,
  healthSchema,
  initializeWalletRequestSchema,
  initializeWalletResponseSchema,
  lifecycleStatusSchema,
  processShutdownRequestSchema,
  processShutdownResponseSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  v1ErrorSchema,
  walletRecoveryMaterialRequestSchema,
  walletRecoveryMaterialResponseSchema,
} from '../../src/v1/http.js';
import { generateV1InterfaceDescription } from '../../src/v1/interface-description.js';

test('the generated v1 interface description comes from the runtime schemas', async () => {
  const generated = generateV1InterfaceDescription(createV1RouteMetadata(), '0.0.17');
  const checkedIn = JSON.parse(
    await Bun.file(new URL('../../docs/lifecycle-api-v1.json', import.meta.url)).text(),
  ) as unknown;

  expect(checkedIn).toEqual(generated);
  expect(generated.schemas).toEqual({
    Error: v1ErrorSchema.jsonSchema,
    Health: healthSchema.jsonSchema,
    LifecycleStatus: lifecycleStatusSchema.jsonSchema,
    Balances: balancesSchema.jsonSchema,
    InitializeWalletRequest: initializeWalletRequestSchema.jsonSchema,
    InitializeWalletResponse: initializeWalletResponseSchema.jsonSchema,
    WalletRecoveryMaterialRequest: walletRecoveryMaterialRequestSchema.jsonSchema,
    WalletRecoveryMaterialResponse: walletRecoveryMaterialResponseSchema.jsonSchema,
    StartSessionRequest: startSessionRequestSchema.jsonSchema,
    StopSessionRequest: stopSessionRequestSchema.jsonSchema,
    ProcessShutdownRequest: processShutdownRequestSchema.jsonSchema,
    ProcessShutdownResponse: processShutdownResponseSchema.jsonSchema,
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
      responseCacheControl: null,
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
      responseCacheControl: null,
    },
    {
      method: 'GET',
      path: '/v1/balances',
      capability: 'wallet:read',
      requestSchema: null,
      responseSchema: 'Balances',
      errorSchema: 'Error',
      successStatuses: [200],
      idempotencyKey: null,
      responseCacheControl: null,
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
      responseCacheControl: 'no-store',
    },
    {
      method: 'POST',
      path: '/v1/admin/wallet/recovery-material',
      capability: 'wallet:admin',
      requestSchema: 'WalletRecoveryMaterialRequest',
      responseSchema: 'WalletRecoveryMaterialResponse',
      errorSchema: 'Error',
      successStatuses: [200],
      idempotencyKey: null,
      responseCacheControl: 'no-store',
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
      responseCacheControl: null,
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
      responseCacheControl: null,
    },
    {
      method: 'POST',
      path: '/v1/admin/process/stop',
      capability: 'wallet:admin',
      requestSchema: 'ProcessShutdownRequest',
      responseSchema: 'ProcessShutdownResponse',
      errorSchema: 'Error',
      successStatuses: [202],
      idempotencyKey: 'optional',
      responseCacheControl: null,
    },
  ]);

  expect(generated.schemas.LifecycleStatus).toHaveProperty('oneOf');
  expect(JSON.stringify(generated.schemas.LifecycleStatus)).toContain(
    '^\\\\d{4}-\\\\d{2}-\\\\d{2}T',
  );
  expect(generated.schemas.WalletRecoveryMaterialRequest).toMatchObject({
    properties: { passphrase: { 'x-sensitive': true } },
  });
  expect(generated.schemas.WalletRecoveryMaterialResponse).toMatchObject({
    properties: { mnemonic: { 'x-sensitive': true } },
  });

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
