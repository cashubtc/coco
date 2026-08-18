import type { Logger } from '@cashu/coco-core';

import type { AdministrativeCredential, ClientCapability } from '../credentials.js';
import type { CocodRuntime, CocodStatus } from '../runtime.js';
import { redactLogValue, type AppLogger } from '../utils/logger.js';

export interface RuntimeSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

type V1RouteHandler<TRequest, TResponse> = (
  input: TRequest,
  request: Request,
) => Promise<TResponse> | TResponse;

/** Declares all behavior needed to run and describe one v1 HTTP route. */
export interface V1RouteDefinition<TRequest = unknown, TResponse = unknown> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly capability: ClientCapability | null;
  readonly requestSchema: RuntimeSchema<TRequest>;
  readonly responseSchema: RuntimeSchema<TResponse>;
  readonly handler: V1RouteHandler<TRequest, TResponse>;
}

export interface V1ErrorDocument {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface HealthDocument {
  status: 'ok';
  interfaceVersion: '1';
}

export interface LifecycleStatusDocument {
  daemon: {
    version: string;
    interfaceVersion: '1';
  };
  wallet: {
    configuredAt: string;
  } | null;
  seedAccess: CocodStatus['seedAccess'];
  cocoSession: CocodStatus['cocoSession'];
}

type BunRouteHandlers = Record<
  string,
  {
    GET?: (request: Request) => Promise<Response>;
    POST?: (request: Request) => Promise<Response>;
  }
>;

export type ResponseHeaders = Headers | Record<string, string> | string[][];

export interface V1HttpErrorOptions {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  headers?: ResponseHeaders;
  cause?: unknown;
}

const INTERFACE_VERSION = '1' as const;

interface SchemaNode {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown, path: string): unknown;
}

const rfc3339UtcSchema = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const daemonStatusNode = objectNode({
  version: stringNode(),
  interfaceVersion: literalNode(INTERFACE_VERSION),
});
const walletStatusNode = objectNode({ configuredAt: rfc3339UtcSchema });
const seedAccessStatusNode = objectNode({
  state: enumNode(['locked', 'available']),
  requiresPassphrase: booleanNode(),
});
const lastFailureNode = nullableNode(
  objectNode({
    code: stringNode(),
    message: stringNode(),
    occurredAt: rfc3339UtcSchema,
  }),
);
const cocoSessionStatusNode = objectNode({
  state: enumNode(['stopped', 'starting', 'running', 'stopping', 'failed']),
  startedAt: nullableNode(rfc3339UtcSchema),
  lastFailure: lastFailureNode,
});

export const noBodySchema = namedSchema<null>('NoBody', literalNode(null));
export const healthSchema = namedSchema<HealthDocument>(
  'Health',
  objectNode({
    status: literalNode('ok'),
    interfaceVersion: literalNode(INTERFACE_VERSION),
  }),
);
export const v1ErrorSchema = namedSchema<V1ErrorDocument>(
  'Error',
  objectNode({
    error: objectNode(
      {
        code: stringNode(),
        message: stringNode(),
        retryable: booleanNode(),
        details: objectNode({}, { additionalProperties: true }),
      },
      { optional: ['details'] },
    ),
  }),
);
export const lifecycleStatusSchema = namedSchema<LifecycleStatusDocument>(
  'LifecycleStatus',
  unionNode([
    objectNode({
      daemon: daemonStatusNode,
      wallet: literalNode(null),
      seedAccess: literalNode(null),
      cocoSession: cocoSessionStatusNode,
    }),
    objectNode({
      daemon: daemonStatusNode,
      wallet: walletStatusNode,
      seedAccess: seedAccessStatusNode,
      cocoSession: cocoSessionStatusNode,
    }),
  ]),
);

/** Preserves handler input/output types while erasing them for the common route runner. */
export function defineV1Route<TRequest, TResponse>(
  definition: V1RouteDefinition<TRequest, TResponse>,
): V1RouteDefinition {
  return {
    ...definition,
    handler: (input, request) => definition.handler(input as TRequest, request),
  };
}

/** Creates the Slice 3 v1 route declarations. */
export function createV1RouteDefinitions(
  runtime: CocodRuntime,
  daemonVersion: string,
): Array<V1RouteDefinition> {
  const health = defineV1Route<null, HealthDocument>({
    method: 'GET',
    path: '/health',
    capability: null,
    requestSchema: noBodySchema,
    responseSchema: healthSchema,
    handler: () => ({ status: 'ok', interfaceVersion: INTERFACE_VERSION }),
  });
  const status = defineV1Route<null, LifecycleStatusDocument>({
    method: 'GET',
    path: '/v1/status',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: lifecycleStatusSchema,
    handler: () => toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
  });
  return [health, status];
}

/** Builds Bun route handlers backed by the common v1 route runner. */
export function buildV1Routes(
  definitions: ReadonlyArray<V1RouteDefinition>,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
): BunRouteHandlers {
  const routes: BunRouteHandlers = {};
  for (const definition of definitions) {
    if (definition.path.startsWith('/v1/') && definition.capability === null) {
      throw new Error(`V1 route ${definition.method} ${definition.path} must require a capability`);
    }
    const handlers = (routes[definition.path] ??= {});
    handlers[definition.method] = (request) => runV1Route(definition, request, credentials, logger);
  }
  return routes;
}

/** Gives unknown `/v1` resources stable v1 errors while preserving the legacy fallback. */
export function buildV1FallbackHandler(
  credentials: AdministrativeCredential,
  legacyFallback: (request: Request) => Promise<Response>,
  logger?: AppLogger,
): (request: Request) => Promise<Response> {
  const noSuccessResponseSchema: RuntimeSchema<never> = {
    name: 'Never',
    jsonSchema: { not: {} },
    parse() {
      throw new Error('fallback routes do not return a success response');
    },
  };
  const notFoundRoute = defineV1Route<null, never>({
    method: 'GET',
    path: '/v1/*',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: noSuccessResponseSchema,
    handler: () => {
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'The requested resource does not exist',
        retryable: false,
      });
    },
  });
  const methodNotAllowedRoute = defineV1Route<null, never>({
    method: 'POST',
    path: '/health',
    capability: null,
    requestSchema: noBodySchema,
    responseSchema: noSuccessResponseSchema,
    handler: () => {
      throw new V1HttpError({
        status: 405,
        code: 'method_not_allowed',
        message: 'The requested method is not allowed',
        retryable: false,
        headers: { Allow: 'GET' },
      });
    },
  });

  return async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/health') {
      return runV1Route(methodNotAllowedRoute, request, credentials, logger, {
        requestPath: path,
        skipRequestParsing: true,
      });
    }
    if (path === '/v1' || path.startsWith('/v1/')) {
      return runV1Route(notFoundRoute, request, credentials, logger, {
        requestPath: path,
        skipRequestParsing: true,
      });
    }
    return legacyFallback(request);
  };
}

export class V1HttpError extends Error {
  constructor(readonly options: V1HttpErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'V1HttpError';
  }
}

async function runV1Route(
  definition: V1RouteDefinition,
  request: Request,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
  options: { requestPath?: string; skipRequestParsing?: boolean } = {},
): Promise<Response> {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const requestPath = options.requestPath ?? definition.path;
  const requestLogger =
    logger?.child?.({ method: request.method, path: requestPath, requestId }) ?? logger;

  try {
    if (definition.capability) {
      const authorization = await credentials.authorize(
        request.headers.get('authorization'),
        definition.capability,
      );
      if (authorization !== 'authorized') {
        const status = authorization === 'unauthenticated' ? 401 : 403;
        const response = errorResponse({
          status,
          code: authorization,
          message:
            authorization === 'unauthenticated'
              ? 'A valid Client Credential is required'
              : 'The Client Credential lacks the required capability',
          retryable: false,
          requestId,
          headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined,
        });
        logCompleted(requestLogger, startedAt, response.status);
        return response;
      }
    }

    const input = options.skipRequestParsing
      ? null
      : await parseRequest(request, definition.requestSchema);
    requestLogger?.debug('request.received', { input: redactLogValue(input) });
    const result = await definition.handler(input, request);
    const output = definition.responseSchema.parse(result);
    const response = jsonResponse(output, 200, requestId);
    logCompleted(requestLogger, startedAt, response.status);
    return response;
  } catch (error) {
    const response = mapError(error, requestId);
    const fields = {
      durationMs: Math.round(performance.now() - startedAt),
      error: { name: error instanceof Error ? error.name : 'UnknownError' },
      status: response.status,
    };
    if (response.status >= 500) {
      requestLogger?.error('request.failed', fields);
    } else {
      requestLogger?.warn('request.rejected', fields);
    }
    return response;
  }
}

async function parseRequest<T>(request: Request, schema: RuntimeSchema<T>): Promise<T> {
  let value: unknown = null;
  if (request.method !== 'GET') {
    const body = await request.text();
    if (body.length > 0) {
      try {
        value = JSON.parse(body) as unknown;
      } catch (error) {
        throw new V1HttpError({
          status: 400,
          code: 'invalid_request',
          message: 'The request body is not valid JSON',
          retryable: false,
          cause: error,
        });
      }
    }
  }

  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof V1HttpError) {
      throw error;
    }
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'The request does not match the expected schema',
      retryable: false,
      cause: error,
    });
  }
}

function mapError(error: unknown, requestId: string): Response {
  if (error instanceof V1HttpError) {
    return errorResponse({
      ...error.options,
      requestId,
    });
  }
  return errorResponse({
    status: 500,
    code: 'internal_error',
    message: 'The request could not be completed',
    retryable: false,
    requestId,
  });
}

function errorResponse({
  status,
  code,
  message,
  retryable,
  requestId,
  headers,
  details,
}: V1HttpErrorOptions & { requestId: string }): Response {
  const body: V1ErrorDocument = {
    error: { code, message, retryable, ...(details ? { details } : {}) },
  };
  return jsonResponse(v1ErrorSchema.parse(body), status, requestId, headers);
}

function jsonResponse(
  body: unknown,
  status: number,
  requestId: string,
  headers?: ResponseHeaders,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('X-Request-ID', requestId);
  return Response.json(body, { status, headers: responseHeaders });
}

function logCompleted(logger: Logger | undefined, startedAt: number, status: number): void {
  const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  logger?.[level]('request.completed', {
    durationMs: Math.round(performance.now() - startedAt),
    status,
  });
}

function toLifecycleStatusDocument(
  status: CocodStatus,
  daemonVersion: string,
): LifecycleStatusDocument {
  return {
    daemon: { version: daemonVersion, interfaceVersion: INTERFACE_VERSION },
    wallet: status.wallet ? { configuredAt: status.wallet.configuredAt } : null,
    seedAccess: status.seedAccess,
    cocoSession: status.cocoSession,
  };
}

function namedSchema<T>(name: string, node: SchemaNode): RuntimeSchema<T> {
  return {
    name,
    jsonSchema: node.jsonSchema,
    parse(value) {
      return node.parse(value, '$') as T;
    },
  };
}

function literalNode<T extends string | null>(expected: T): SchemaNode {
  return {
    jsonSchema: expected === null ? { type: 'null' } : { const: expected },
    parse(value, path) {
      if (value !== expected) {
        throw new Error(`${path} must equal ${JSON.stringify(expected)}`);
      }
      return expected;
    },
  };
}

function stringNode(options: { format?: 'date-time'; pattern?: string } = {}): SchemaNode {
  return {
    jsonSchema: { type: 'string', ...options },
    parse(value, path) {
      if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
      }
      if (options.pattern && !new RegExp(options.pattern).test(value)) {
        throw new Error(`${path} does not match the required pattern`);
      }
      if (
        options.format === 'date-time' &&
        (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      ) {
        throw new Error(`${path} must be an RFC 3339 UTC timestamp`);
      }
      return value;
    },
  };
}

function booleanNode(): SchemaNode {
  return {
    jsonSchema: { type: 'boolean' },
    parse(value, path) {
      if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
      }
      return value;
    },
  };
}

function enumNode(values: readonly string[]): SchemaNode {
  return {
    jsonSchema: { enum: values },
    parse(value, path) {
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new Error(`${path} must be one of ${values.join(', ')}`);
      }
      return value;
    },
  };
}

function nullableNode(node: SchemaNode): SchemaNode {
  return unionNode([literalNode(null), node], 'anyOf');
}

function objectNode(
  properties: Readonly<Record<string, SchemaNode>>,
  options: { optional?: readonly string[]; additionalProperties?: boolean } = {},
): SchemaNode {
  const optional = new Set(options.optional ?? []);
  const additionalProperties = options.additionalProperties ?? false;
  const required = Object.keys(properties).filter((key) => !optional.has(key));
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties,
      required,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, node]) => [key, node.jsonSchema]),
      ),
    },
    parse(value, path) {
      const record = requireRecord(value, path);
      if (!additionalProperties) {
        requireOnlyKeys(record, Object.keys(properties), path);
      }
      const parsed: Record<string, unknown> = additionalProperties ? { ...record } : {};
      for (const [key, node] of Object.entries(properties)) {
        if (!(key in record)) {
          if (optional.has(key)) {
            continue;
          }
          throw new Error(`${path}.${key} is required`);
        }
        parsed[key] = node.parse(record[key], `${path}.${key}`);
      }
      return parsed;
    },
  };
}

function unionNode(nodes: readonly SchemaNode[], keyword: 'oneOf' | 'anyOf' = 'oneOf'): SchemaNode {
  return {
    jsonSchema: { [keyword]: nodes.map((node) => node.jsonSchema) },
    parse(value, path) {
      const matches: unknown[] = [];
      const errors: unknown[] = [];
      for (const node of nodes) {
        try {
          matches.push(node.parse(value, path));
        } catch (error) {
          errors.push(error);
        }
      }
      if (matches.length === 0 || (keyword === 'oneOf' && matches.length !== 1)) {
        throw new AggregateError(errors, `${path} does not match ${keyword}`);
      }
      return matches[0];
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains an unexpected field`);
  }
}
