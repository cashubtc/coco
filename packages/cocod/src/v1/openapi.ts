import type { V1RouteMetadata } from './contract.js';
import { v1ErrorSchema } from './schema.js';
import type { RuntimeSchema } from './schema-nodes.js';

/** OpenAPI 3.1 description of cocod's v1 interface, generated from the runtime route metadata. */
export interface V1OpenApiDocument {
  openapi: '3.1.0';
  info: { title: string; version: string; 'x-interface-version': '1' };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: Record<string, Readonly<Record<string, unknown>>>;
    securitySchemes: Record<string, unknown>;
  };
}

const IDEMPOTENCY_KEY_PARAMETER = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description:
    'Replays the original result of a repeated identical request within this Cocod Process.',
  schema: { type: 'string', pattern: '^[\\x21-\\x7e]{1,255}$' },
};

/**
 * Generates the OpenAPI document from the same route metadata and schemas the HTTP server uses,
 * so the published contract cannot drift from runtime validation.
 */
export function generateV1OpenApiDocument(
  routes: ReadonlyArray<V1RouteMetadata>,
  daemonVersion: string,
): V1OpenApiDocument {
  const schemas: V1OpenApiDocument['components']['schemas'] = {};
  const reference = (schema: RuntimeSchema<unknown>) => {
    addSchema(schemas, schema);
    return { $ref: `#/components/schemas/${schema.name}` };
  };
  const errorResponse = {
    description: 'Error document; `error.code` is stable interface data.',
    content: { 'application/json': { schema: reference(v1ErrorSchema) } },
  };

  const paths: V1OpenApiDocument['paths'] = {};
  for (const route of routes) {
    const parameters = [
      ...Object.entries(route.parameters ?? {}).map(([name, parameter]) => ({
        name,
        in: parameter.in,
        required: parameter.required,
        ...(parameter.description ? { description: parameter.description } : {}),
        schema: parameter.schema,
        ...(parameter.explode ? { style: 'form', explode: true } : {}),
      })),
      ...(route.idempotencyKey === 'optional' ? [IDEMPOTENCY_KEY_PARAMETER] : []),
    ];
    const mediaType = route.responseMediaType ?? 'application/json';
    const successHeaders =
      route.responseCacheControl === 'no-store'
        ? { headers: { 'Cache-Control': { schema: { const: 'no-store' } } } }
        : {};
    const operation = {
      operationId: operationId(route),
      ...(route.summary ? { summary: route.summary } : {}),
      security: route.capability ? [{ clientCredential: [] }] : [],
      'x-cocod-capability': route.capability,
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(route.requestSchema.name === 'NoBody'
        ? {}
        : {
            requestBody: {
              required: route.requestSchema.name !== 'EmptyCommandRequest',
              content: { 'application/json': { schema: reference(route.requestSchema) } },
            },
          }),
      responses: {
        ...Object.fromEntries(
          (route.successStatuses ?? [200]).map((status) => [
            String(status),
            {
              description:
                mediaType === 'text/event-stream'
                  ? 'Server-sent events; each `data` line carries one document.'
                  : 'Success',
              ...successHeaders,
              content: { [mediaType]: { schema: reference(route.responseSchema) } },
            },
          ]),
        ),
        default: errorResponse,
      },
    };
    const pathItem = (paths[route.path] ??= {});
    const method = route.method.toLowerCase();
    if (pathItem[method]) throw new Error(`Duplicate route ${route.method} ${route.path}`);
    pathItem[method] = operation;
  }

  return {
    openapi: '3.1.0',
    info: { title: 'cocod', version: daemonVersion, 'x-interface-version': '1' },
    paths,
    components: {
      schemas,
      securitySchemes: { clientCredential: { type: 'http', scheme: 'bearer' } },
    },
  };
}

function operationId(route: V1RouteMetadata): string {
  const words = route.path
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== 'v1')
    .flatMap((segment) => segment.replace(/[{}]/g, '').split(/[^A-Za-z0-9]+/))
    .filter((word) => word.length > 0);
  return [route.method.toLowerCase(), ...words]
    .map((word, index) => (index === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join('');
}

function addSchema(
  schemas: V1OpenApiDocument['components']['schemas'],
  schema: RuntimeSchema<unknown>,
): void {
  const existing = schemas[schema.name];
  if (existing && JSON.stringify(existing) !== JSON.stringify(schema.jsonSchema)) {
    throw new Error(`Conflicting runtime schemas named ${schema.name}`);
  }
  schemas[schema.name] = schema.jsonSchema;
}
