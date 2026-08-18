import { expect, test } from 'bun:test';

import type { CocodRuntime } from '../../src/runtime.js';
import {
  createV1RouteDefinitions,
  healthSchema,
  lifecycleStatusSchema,
  v1ErrorSchema,
} from '../../src/v1/http.js';
import { generateV1InterfaceDescription } from '../../src/v1/interface-description.js';

test('the generated lifecycle interface description comes from the runtime schemas', async () => {
  const definitions = createV1RouteDefinitions({} as CocodRuntime, '0.0.17');
  const generated = generateV1InterfaceDescription(definitions, '0.0.17');
  const checkedIn = JSON.parse(
    await Bun.file(new URL('../../docs/lifecycle-api-v1.json', import.meta.url)).text(),
  ) as unknown;

  expect(checkedIn).toEqual(generated);
  expect(generated.schemas).toEqual({
    Error: v1ErrorSchema.jsonSchema,
    Health: healthSchema.jsonSchema,
    LifecycleStatus: lifecycleStatusSchema.jsonSchema,
  });
  expect(generated.routes).toEqual([
    {
      method: 'GET',
      path: '/health',
      capability: null,
      requestSchema: null,
      responseSchema: 'Health',
      errorSchema: 'Error',
    },
    {
      method: 'GET',
      path: '/v1/status',
      capability: 'wallet:read',
      requestSchema: null,
      responseSchema: 'LifecycleStatus',
      errorSchema: 'Error',
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
