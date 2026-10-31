import { expect, test } from 'bun:test';

import packageJson from '../../package.json' with { type: 'json' };
import { createV1RouteMetadata, generateV1OpenApiDocument } from '../../src/v1/http.js';

const document = generateV1OpenApiDocument(createV1RouteMetadata(), packageJson.version);
const routes = createV1RouteMetadata();

function containsSensitiveField(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  if ((schema as Record<string, unknown>)['x-sensitive'] === true) return true;
  return Object.values(schema).some(containsSensitiveField);
}

test('the committed OpenAPI document matches the runtime route metadata', async () => {
  const committed = JSON.parse(
    await Bun.file(new URL('../../docs/openapi-v1.json', import.meta.url)).text(),
  ) as unknown;

  expect(committed).toEqual(JSON.parse(JSON.stringify(document)));
});

test('every v1 route requires a Client Credential', () => {
  for (const route of routes) {
    if (route.path === '/health') continue;
    expect([route.path, route.capability]).not.toEqual([route.path, null]);
  }
});

test('routes that return secrets or bearer value require wallet:admin and are not cached', () => {
  const sensitive = routes.filter((route) =>
    containsSensitiveField(route.responseSchema.jsonSchema),
  );

  expect(sensitive.map((route) => `${route.method} ${route.path}`).toSorted()).toEqual([
    'GET /v1/operations/melt/{operationId}/result',
    'GET /v1/operations/send/{operationId}/result',
    'POST /v1/admin/wallet/initialize',
    'POST /v1/admin/wallet/recovery-material',
    'POST /v1/operations/melt/{operationId}/execute',
    'POST /v1/operations/send/{operationId}/execute',
  ]);
  for (const route of sensitive) {
    expect([route.path, route.capability, route.responseCacheControl]).toEqual([
      route.path,
      'wallet:admin',
      'no-store',
    ]);
  }
});

test('GET routes neither accept request bodies nor declare idempotency keys', () => {
  for (const route of routes.filter((candidate) => candidate.method === 'GET')) {
    expect([route.path, route.requestSchema.name, route.idempotencyKey]).toEqual([
      route.path,
      'NoBody',
      null,
    ]);
  }
});

test('operation identifiers are unique and every operation documents its errors', () => {
  const operations = Object.values(document.paths).flatMap((pathItem) =>
    Object.values(pathItem),
  ) as Array<{ operationId: string; responses: Record<string, unknown> }>;
  const ids = operations.map((operation) => operation.operationId);

  expect(new Set(ids).size).toBe(ids.length);
  for (const operation of operations) {
    expect(operation.responses.default).toBeDefined();
  }
});
