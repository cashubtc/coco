import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import {
  buildV1Routes,
  createV1RouteDefinitions,
  createV1RouteMetadata,
  type V1Runtime,
} from '../../src/v1/http.js';
import { generateV1OpenApiDocument } from '../../src/v1/interface-description.js';

test('generates OpenAPI 3.1 from the complete runtime route metadata', () => {
  const metadata = createV1RouteMetadata();
  const document = generateV1OpenApiDocument(metadata, '0.0.17');

  expect(document.openapi).toBe('3.1.0');
  expect(document.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(document.info).toEqual({ title: 'cocod v1', version: '0.0.17' });
  expect(document['x-cocod-interface-version']).toBe('1');
  expect(document.components.securitySchemes).toEqual({
    bearerAuth: { type: 'http', scheme: 'bearer' },
  });

  const advertised = Object.entries(document.paths)
    .flatMap(([path, item]) => Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`))
    .toSorted();
  const implemented = metadata.map(({ method, path }) => `${method} ${path}`).toSorted();
  const executable = createV1RouteDefinitions({} as V1Runtime, '0.0.17', {
    request: () => {
      throw new Error('unexpected shutdown');
    },
  })
    .map(({ method, path }) => `${method} ${path}`)
    .toSorted();
  expect(advertised).toEqual(implemented);
  expect(executable).toEqual(implemented);
  expect(advertised).toContain('GET /v1/openapi.json');
  expect(document.paths['/health']!.get!.security).toEqual([]);
  expect(document.paths['/v1/status']!.get!.security).toEqual([{ bearerAuth: [] }]);
  expect(document.paths['/v1/status']!.get!['x-cocod-capability']).toBe('wallet:read');
});

test('describes shared runtime parameters and the SSE representation exactly', () => {
  const document = generateV1OpenApiDocument(createV1RouteMetadata(), '0.0.17');

  expect(document.paths['/v1/balances']!.get!.parameters).toEqual([
    {
      name: 'mintUrl',
      in: 'query',
      required: false,
      style: 'form',
      explode: true,
      schema: {
        type: 'array',
        items: { type: 'string', format: 'uri', pattern: '^https?://' },
      },
    },
    {
      name: 'unit',
      in: 'query',
      required: false,
      style: 'form',
      explode: true,
      schema: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
    {
      name: 'trustedOnly',
      in: 'query',
      required: false,
      schema: { type: 'boolean' },
    },
  ]);
  expect(document.paths['/v1/history']!.get!.parameters).toEqual([
    {
      name: 'offset',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 0, default: 0 },
    },
    {
      name: 'limit',
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    },
  ]);
  expect(document.paths['/v1/history/{historyEntryId}']!.get!.parameters).toEqual([
    {
      name: 'historyEntryId',
      in: 'path',
      required: true,
      schema: { type: 'string', minLength: 1 },
    },
  ]);

  const events = document.paths['/v1/events']!.get!;
  expect(events.responses['200']!.content).toEqual({
    'text/event-stream': {
      schema: { type: 'string' },
      'x-sse-event-schema': { $ref: '#/components/schemas/ResourceInvalidationEvent' },
    },
  });
  expect(events.responses['200']!.headers!['Cache-Control']).toEqual({
    schema: { type: 'string', const: 'no-store' },
  });
});

test('keeps OpenAPI schemas, statuses, capabilities, and parameters aligned with runtime metadata', () => {
  const metadata = createV1RouteMetadata();
  const document = generateV1OpenApiDocument(metadata, '0.0.17');

  for (const route of metadata) {
    const operation = document.paths[route.path]![route.method.toLowerCase() as 'get' | 'post']!;
    expect(operation['x-cocod-capability'] ?? null).toBe(route.capability);
    expect(operation.security).toEqual(route.capability ? [{ bearerAuth: [] }] : []);
    expect(Object.keys(operation.responses).filter((status) => status !== 'default')).toEqual(
      (route.successStatuses ?? [200]).map(String),
    );
    expect(document.components.schemas[route.responseSchema.name]).toEqual(
      route.responseSchema.jsonSchema,
    );

    if (route.requestSchema.name === 'NoBody') {
      expect(operation.requestBody).toBeUndefined();
    } else {
      expect(operation.requestBody!.content['application/json'].schema).toEqual({
        $ref: `#/components/schemas/${route.requestSchema.name}`,
      });
      expect(document.components.schemas[route.requestSchema.name]).toEqual(
        route.requestSchema.jsonSchema,
      );
    }

    const parameters = operation.parameters ?? [];
    const documentedRouteParameters = parameters.filter(
      (parameter) => parameter.name !== 'Idempotency-Key',
    );
    expect(documentedRouteParameters).toEqual([...(route.parameters ?? [])]);
    expect(parameters.some((parameter) => parameter.name === 'Idempotency-Key')).toBe(
      route.idempotencyKey === 'optional',
    );
    const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    expect(
      parameters
        .filter((parameter) => parameter.in === 'path' && parameter.required)
        .map((parameter) => parameter.name),
    ).toEqual(placeholders);
  }
});

test('does not advertise unsupported, legacy, or Location-based interface concepts', () => {
  const document = generateV1OpenApiDocument(createV1RouteMetadata(), '0.0.17');
  const serialized = JSON.stringify(document);

  expect(document.paths['/v1/mints/{mintUrl}']).toBeUndefined();
  expect(document.paths['/v1/payment-requests/incoming']).toBeUndefined();
  expect(document.paths['/npc/address']).toBeUndefined();
  expect(document.paths['/events']).toBeUndefined();
  expect(serialized).not.toContain('Location');
  expect(serialized).not.toContain('Last-Event-ID');
});

test('keeps the checked-in OpenAPI artifact equal to runtime generation', async () => {
  const checkedIn = JSON.parse(
    await Bun.file(new URL('../../docs/openapi-v1.json', import.meta.url)).text(),
  ) as unknown;
  expect(checkedIn).toEqual(generateV1OpenApiDocument(createV1RouteMetadata(), '0.0.17'));
});

test('serves the generated document only to authenticated readers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-openapi-'));
  try {
    const credentialDirectory = join(directory, 'credentials');
    const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
    const plaintext = await loadClientCredential(join(credentialDirectory, 'current', 'client'));
    const runtime = {} as V1Runtime;
    const routes = buildV1Routes(
      createV1RouteDefinitions(runtime, '0.0.17', {
        request: () => {
          throw new Error('unexpected shutdown');
        },
      }),
      credentials,
    );
    const handler = routes['/v1/openapi.json']!.GET!;

    const unauthorized = await handler(new Request('http://localhost/v1/openapi.json'));
    const authorized = await handler(
      new Request('http://localhost/v1/openapi.json', {
        headers: { Authorization: `Bearer ${plaintext}` },
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });
    expect(authorized.status).toBe(200);
    expect(authorized.headers.get('content-type')).toContain('application/json');
    expect(authorized.headers.get('location')).toBeNull();
    expect(await authorized.json()).toEqual(
      generateV1OpenApiDocument(createV1RouteMetadata(), '0.0.17'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
