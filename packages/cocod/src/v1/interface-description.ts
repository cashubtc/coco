import type { V1RouteMetadata, V1RouteParameter } from './contract.js';
import { v1ErrorSchema, type RuntimeSchema } from './schema.js';

type JsonSchema = Readonly<Record<string, unknown>>;

export interface OpenApiMediaType {
  schema: JsonSchema;
  'x-sse-event-schema'?: { $ref: string };
}

export interface OpenApiResponse {
  description: string;
  headers?: Record<string, { schema: JsonSchema }>;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  operationId: string;
  security: Array<{ bearerAuth: never[] }>;
  'x-cocod-capability'?: NonNullable<V1RouteMetadata['capability']>;
  parameters?: V1RouteParameter[];
  requestBody?: {
    required: true;
    content: { 'application/json': OpenApiMediaType };
  };
  responses: Record<string, OpenApiResponse>;
}

export interface V1OpenApiDocument {
  openapi: '3.1.0';
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema';
  info: { title: 'cocod v1'; version: string };
  'x-cocod-interface-version': '1';
  paths: Record<string, { get?: OpenApiOperation; post?: OpenApiOperation }>;
  components: {
    securitySchemes: { bearerAuth: { type: 'http'; scheme: 'bearer' } };
    schemas: Record<string, JsonSchema>;
  };
}

/** Generates OpenAPI from the same route metadata and schemas enforced by the runtime. */
export function generateV1OpenApiDocument(
  definitions: ReadonlyArray<V1RouteMetadata>,
  daemonVersion: string,
): V1OpenApiDocument {
  const schemas: Record<string, JsonSchema> = {
    [v1ErrorSchema.name]: v1ErrorSchema.jsonSchema,
  };
  const paths: V1OpenApiDocument['paths'] = {};
  const operationIds = new Set<string>();

  for (const definition of definitions) {
    addSchema(schemas, definition.responseSchema);
    if (definition.requestSchema.name !== 'NoBody') addSchema(schemas, definition.requestSchema);

    validateParameters(definition);
    const operationId = createOperationId(definition.method, definition.path);
    if (operationIds.has(operationId))
      throw new Error(`Duplicate OpenAPI operationId ${operationId}`);
    operationIds.add(operationId);

    const parameters = [...(definition.parameters ?? [])];
    if (definition.idempotencyKey === 'optional') {
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: false,
        schema: {
          type: 'string',
          minLength: 1,
          maxLength: 255,
          pattern: '^[\\x21-\\x7e]{1,255}$',
        },
      });
    }

    const operation: OpenApiOperation = {
      operationId,
      security: definition.capability ? [{ bearerAuth: [] }] : [],
      ...(definition.capability ? { 'x-cocod-capability': definition.capability } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(definition.requestSchema.name === 'NoBody'
        ? {}
        : {
            requestBody: {
              required: true as const,
              content: {
                'application/json': {
                  schema: schemaReference(definition.requestSchema.name),
                },
              },
            },
          }),
      responses: createResponses(definition),
    };
    const pathItem = (paths[definition.path] ??= {});
    pathItem[definition.method.toLowerCase() as 'get' | 'post'] = operation;
  }

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: { title: 'cocod v1', version: daemonVersion },
    'x-cocod-interface-version': '1',
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas,
    },
  };
}

function createResponses(definition: V1RouteMetadata): Record<string, OpenApiResponse> {
  const responses: Record<string, OpenApiResponse> = {};
  for (const status of definition.successStatuses ?? [200]) {
    const headers = responseHeaders(definition.responseCacheControl ?? null);
    responses[String(status)] = {
      description: 'Successful response',
      headers,
      content:
        definition.responseMediaType === 'text/event-stream'
          ? {
              'text/event-stream': {
                schema: { type: 'string' },
                'x-sse-event-schema': schemaReference(definition.responseSchema.name),
              },
            }
          : {
              'application/json': {
                schema: schemaReference(definition.responseSchema.name),
              },
            },
    };
  }
  responses.default = {
    description: 'Error response',
    headers: {
      ...responseHeaders(definition.responseCacheControl ?? null),
      'WWW-Authenticate': { schema: { type: 'string' } },
    },
    content: {
      'application/json': { schema: schemaReference(v1ErrorSchema.name) },
    },
  };
  return responses;
}

function responseHeaders(cacheControl: 'no-store' | null): Record<string, { schema: JsonSchema }> {
  return {
    'X-Request-ID': { schema: { type: 'string', format: 'uuid' } },
    ...(cacheControl
      ? { 'Cache-Control': { schema: { type: 'string', const: cacheControl } } }
      : {}),
  };
}

function schemaReference(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function addSchema(schemas: Record<string, JsonSchema>, schema: RuntimeSchema<unknown>): void {
  const existing = schemas[schema.name];
  if (existing && JSON.stringify(existing) !== JSON.stringify(schema.jsonSchema)) {
    throw new Error(`Conflicting runtime schemas named ${schema.name}`);
  }
  schemas[schema.name] = schema.jsonSchema;
}

function validateParameters(definition: V1RouteMetadata): void {
  const placeholders = [...definition.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  const pathParameters = (definition.parameters ?? []).filter(
    (parameter) => parameter.in === 'path',
  );
  const declared = pathParameters.map((parameter) => parameter.name);
  if (
    placeholders.length !== declared.length ||
    placeholders.some((placeholder) => !declared.includes(placeholder)) ||
    pathParameters.some((parameter) => !parameter.required)
  ) {
    throw new Error(`${definition.method} ${definition.path} has inconsistent path parameters`);
  }
}

function createOperationId(method: V1RouteMetadata['method'], path: string): string {
  const words = path.match(/[A-Za-z0-9]+/g) ?? [];
  return `${method.toLowerCase()}${words.map(capitalize).join('')}`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}
