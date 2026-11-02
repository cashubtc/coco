import { expect, test } from 'bun:test';

import packageJson from '../../package.json' with { type: 'json' };
import {
  createV1RouteMetadata,
  generateV1OpenApiDocument,
  emptyCommandRequestSchema,
  noBodySchema,
  type V1RouteMetadata,
} from '../../src/v1/http.js';
import { pageParameters, pathIdentifier, queryStrings } from '../../src/v1/resources/shared.js';

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

test('describes exactly the implemented v1 routes and components', () => {
  expect(Object.keys(document.paths).toSorted()).toEqual([
    '/health',
    '/v1/admin/process/stop',
    '/v1/admin/session/start',
    '/v1/admin/session/stop',
    '/v1/admin/wallet/initialize',
    '/v1/admin/wallet/recovery-material',
    '/v1/balances',
    '/v1/events',
    '/v1/history',
    '/v1/history/{historyEntryId}',
    '/v1/mints',
    '/v1/mints/info',
    '/v1/mints/payment-method-capabilities',
    '/v1/mints/trust',
    '/v1/mints/untrust',
    '/v1/openapi.json',
    '/v1/operations/melt',
    '/v1/operations/melt/in-flight',
    '/v1/operations/melt/prepared',
    '/v1/operations/melt/{operationId}',
    '/v1/operations/melt/{operationId}/cancel',
    '/v1/operations/melt/{operationId}/execute',
    '/v1/operations/melt/{operationId}/reclaim',
    '/v1/operations/melt/{operationId}/refresh',
    '/v1/operations/melt/{operationId}/result',
    '/v1/operations/mint',
    '/v1/operations/mint/in-flight',
    '/v1/operations/mint/pending',
    '/v1/operations/mint/{operationId}',
    '/v1/operations/mint/{operationId}/execute',
    '/v1/operations/mint/{operationId}/refresh',
    '/v1/operations/receive',
    '/v1/operations/receive/in-flight',
    '/v1/operations/receive/prepared',
    '/v1/operations/receive/{operationId}',
    '/v1/operations/receive/{operationId}/cancel',
    '/v1/operations/receive/{operationId}/execute',
    '/v1/operations/receive/{operationId}/refresh',
    '/v1/operations/send',
    '/v1/operations/send/in-flight',
    '/v1/operations/send/prepared',
    '/v1/operations/send/{operationId}',
    '/v1/operations/send/{operationId}/cancel',
    '/v1/operations/send/{operationId}/execute',
    '/v1/operations/send/{operationId}/reclaim',
    '/v1/operations/send/{operationId}/refresh',
    '/v1/operations/send/{operationId}/result',
    '/v1/payment-requests/evaluate',
    '/v1/quotes/melt',
    '/v1/quotes/melt/pending',
    '/v1/quotes/melt/{quoteId}',
    '/v1/quotes/melt/{quoteId}/refresh',
    '/v1/quotes/mint',
    '/v1/quotes/mint/pending',
    '/v1/quotes/mint/{quoteId}',
    '/v1/quotes/mint/{quoteId}/refresh',
    '/v1/status',
  ]);
  expect(Object.keys(document.components.schemas).toSorted()).toEqual([
    'Balances',
    'CreateMeltQuoteRequest',
    'CreateMintQuoteRequest',
    'EmptyCommandRequest',
    'Error',
    'EvaluatePaymentRequestRequest',
    'ExecuteMeltOperationResponse',
    'ExecuteSendOperationResponse',
    'Health',
    'History',
    'HistoryPage',
    'InitializeWalletRequest',
    'InitializeWalletResponse',
    'KnownMint',
    'KnownMints',
    'LifecycleStatus',
    'MeltOperation',
    'MeltOperations',
    'MeltQuote',
    'MeltResult',
    'MintInformation',
    'MintOperation',
    'MintOperations',
    'MintQuote',
    'MintTrustRequest',
    'OpenApiDocument',
    'PaymentMethodCapabilities',
    'PaymentRequestEvaluation',
    'PendingMeltQuotes',
    'PendingMintQuotes',
    'PrepareMeltOperationRequest',
    'PrepareMintOperationRequest',
    'PrepareReceiveOperationRequest',
    'PrepareSendOperationRequest',
    'ProcessShutdownRequest',
    'ProcessShutdownResponse',
    'ReceiveOperation',
    'ReceiveOperations',
    'RegisterMintRequest',
    'ResourceEvent',
    'SendOperation',
    'SendOperations',
    'SendResult',
    'StartSessionRequest',
    'StopSessionRequest',
    'WalletRecoveryMaterialRequest',
    'WalletRecoveryMaterialResponse',
  ]);
  expect(document.components.securitySchemes).toEqual({
    clientCredential: { type: 'http', scheme: 'bearer' },
  });
  expect(document.paths['/health']!.get).toMatchObject({ security: [] });
  expect(document.paths['/v1/openapi.json']!.get).toMatchObject({
    security: [{ clientCredential: [] }],
    'x-cocod-capability': 'wallet:read',
  });
  expect(document.paths['/v1/admin/wallet/initialize']!.post).toMatchObject({
    parameters: [
      expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: false }),
    ],
    responses: {
      '201': { headers: { 'Cache-Control': { schema: { const: 'no-store' } } } },
      '202': expect.anything(),
    },
  });
});

test('OpenAPI retains path templates, parameter constraints, and optional empty command bodies', () => {
  const route: V1RouteMetadata = {
    method: 'POST',
    path: '/v1/test/{id}',
    capability: 'wallet:admin',
    requestSchema: emptyCommandRequestSchema,
    responseSchema: noBodySchema,
    parameters: { id: pathIdentifier('ID'), ...pageParameters, label: queryStrings('Labels') },
  };
  const generated = generateV1OpenApiDocument([route], 'test');
  expect(generated.paths['/v1/test/{id}']!.post).toMatchObject({
    requestBody: { required: false },
    parameters: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID',
        schema: { type: 'string', minLength: 1, maxLength: 512 },
      },
      {
        name: 'offset',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
      },
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      {
        name: 'label',
        in: 'query',
        required: false,
        description: 'Labels',
        style: 'form',
        explode: true,
        schema: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    ],
  });
  expect(() => generateV1OpenApiDocument([route, route], 'test')).toThrow('Duplicate route');
});

test('Wallet routes advertise read/admin boundaries and repeatable balance filters', () => {
  for (const route of routes.filter(({ path }) =>
    /^\/v1\/(balances|mints|history)(\/|$)/.test(path),
  )) {
    expect(route.capability).toBe(route.method === 'GET' ? 'wallet:read' : 'wallet:admin');
    expect(route.idempotencyKey).toBe(route.method === 'GET' ? null : 'optional');
  }
  expect(document.paths['/v1/balances']!.get).toMatchObject({
    parameters: [
      expect.objectContaining({ name: 'mintUrl', in: 'query', explode: true }),
      expect.objectContaining({ name: 'unit', in: 'query', explode: true }),
      expect.objectContaining({ name: 'trustedOnly', schema: { type: 'boolean' } }),
    ],
  });
  expect(document.paths['/v1/history/{historyEntryId}']!.get).toMatchObject({
    parameters: [expect.objectContaining({ name: 'historyEntryId', in: 'path', required: true })],
  });
});

test('events document their media type, safe schema, read capability and cache policy', () => {
  const operation = document.paths['/v1/events']!.get as { responses: Record<string, unknown> };
  expect(operation).toMatchObject({
    security: [{ clientCredential: [] }],
    'x-cocod-capability': 'wallet:read',
    responses: {
      '200': {
        description: 'Server-sent events; each `data` line carries one document.',
        headers: { 'Cache-Control': { schema: { const: 'no-store' } } },
        content: {
          'text/event-stream': { schema: { $ref: '#/components/schemas/ResourceEvent' } },
        },
      },
      default: {
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  });
  expect(containsSensitiveField(document.components.schemas.ResourceEvent)).toBe(false);
  for (const route of routes.filter(({ path }) => path !== '/v1/events')) {
    expect(route.responseMediaType ?? 'application/json').toBe('application/json');
  }
});
