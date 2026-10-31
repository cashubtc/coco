import type { Logger } from '@cashu/coco-core';

import type { AdministrativeCredential } from '../credentials.js';
import { CocodRuntimeError, type CocodRuntimeErrorCode } from '../runtime-error.js';
import { redactLogValue, type AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  V1HttpError,
  V1HttpResponse,
  V1HttpStreamResponse,
  type ResponseHeaders,
  type V1HttpErrorOptions,
  type V1RouteDefinition,
} from './contract.js';
import {
  IdempotencyCapacityError,
  IdempotencyKeyConflictError,
  ProcessLocalIdempotency,
} from './idempotency.js';
import {
  noBodySchema,
  v1ErrorSchema,
  type RuntimeSchema,
  type V1ErrorCode,
  type V1ErrorDocument,
} from './schema.js';

type BunRequestHandler = (
  request: Request & { params?: Record<string, string> },
) => Promise<Response>;

type BunRouteHandlers = Record<string, { GET?: BunRequestHandler; POST?: BunRequestHandler }>;

/** Builds Bun route handlers backed by one shared v1 runner and idempotency store. */
export function buildV1Routes(
  definitions: ReadonlyArray<V1RouteDefinition>,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
  options: { isAcceptingWork?: () => boolean } = {},
): BunRouteHandlers {
  const routes: BunRouteHandlers = {};
  const idempotency = new ProcessLocalIdempotency();
  for (const definition of definitions) {
    if (definition.path.startsWith('/v1/') && definition.capability === null) {
      throw new Error(`V1 route ${definition.method} ${definition.path} must require a capability`);
    }
    assertPathParametersDeclared(definition);
    const runtimePath = definition.path.replaceAll(PATH_TEMPLATE_SEGMENT, ':$1');
    const handlers = (routes[runtimePath] ??= {});
    if (handlers[definition.method]) {
      throw new Error(`V1 route ${definition.method} ${definition.path} is defined twice`);
    }
    handlers[definition.method] = (request) =>
      runV1Route(definition, request, credentials, logger, {
        idempotency,
        isAcceptingWork: options.isAcceptingWork,
        pathParams: request.params ?? {},
      });
  }
  return routes;
}

const PATH_TEMPLATE_SEGMENT = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

function assertPathParametersDeclared(definition: V1RouteDefinition): void {
  const templated = Array.from(
    definition.path.matchAll(PATH_TEMPLATE_SEGMENT),
    (match) => match[1],
  );
  const declared = Object.entries(definition.parameters ?? {})
    .filter(([, parameter]) => parameter.in === 'path')
    .map(([name]) => name);
  if (templated.length !== declared.length || templated.some((name) => !declared.includes(name!))) {
    throw new Error(
      `V1 route ${definition.method} ${definition.path} declares mismatched path parameters`,
    );
  }
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

async function runV1Route(
  definition: V1RouteDefinition,
  request: Request,
  credentials: AdministrativeCredential,
  logger?: AppLogger,
  options: {
    requestPath?: string;
    skipRequestParsing?: boolean;
    idempotency?: ProcessLocalIdempotency;
    isAcceptingWork?: () => boolean;
    pathParams?: Readonly<Record<string, string>>;
  } = {},
): Promise<Response> {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const requestPath = options.requestPath ?? definition.path;
  const authorizationHeader = request.headers.get('authorization');
  const requestLogger =
    logger?.child?.({ method: request.method, path: requestPath, requestId }) ?? logger;
  const withCachePolicy = (response: Response): Response => {
    // Sensitive routes keep intermediaries from replaying stale errors in place of a result.
    if (definition.responseCacheControl) {
      response.headers.set('Cache-Control', definition.responseCacheControl);
    }
    return response;
  };

  try {
    if (definition.capability) {
      const authorization = await credentials.authorize(authorizationHeader, definition.capability);
      if (authorization !== 'authorized') {
        const status = authorization === 'unauthenticated' ? 401 : 403;
        const code: V1ErrorCode = authorization;
        const response = errorResponse({
          status,
          code,
          message:
            authorization === 'unauthenticated'
              ? 'A valid Client Credential is required'
              : 'The Client Credential lacks the required capability',
          retryable: false,
          requestId,
          headers: status === 401 ? { 'WWW-Authenticate': 'Bearer' } : undefined,
        });
        logCompleted(requestLogger, startedAt, response.status);
        return withCachePolicy(response);
      }
    }

    if (definition.path !== '/v1/admin/process/stop' && options.isAcceptingWork?.() === false) {
      throw new V1HttpError({
        status: 503,
        code: 'process_shutting_down',
        message: 'The Cocod Process is shutting down',
        retryable: false,
      });
    }

    const params = options.skipRequestParsing
      ? {}
      : parseParameters(definition, request, options.pathParams ?? {});
    const input = options.skipRequestParsing
      ? null
      : await parseRequest(request, definition.requestSchema);
    requestLogger?.debug('request.received', {
      input: redactLogValue(input),
      params: redactLogValue(params),
    });
    const invokeHandler = () =>
      definition.handler(input, {
        request,
        params,
        reauthorize: async () =>
          definition.capability === null ||
          (await credentials.authorize(authorizationHeader, definition.capability)) ===
            'authorized',
      });
    const result =
      definition.idempotencyKey === 'optional'
        ? await executeIdempotent(
            definition,
            request,
            params,
            input,
            invokeHandler,
            options.idempotency,
          )
        : await invokeHandler();
    if (result instanceof V1HttpStreamResponse) {
      if (definition.responseMediaType !== 'text/event-stream') {
        throw new Error(`${definition.method} ${definition.path} returned an undocumented stream`);
      }
      const responseHeaders = new Headers();
      responseHeaders.set('Content-Type', 'text/event-stream');
      responseHeaders.set('X-Request-ID', requestId);
      const response = withCachePolicy(
        new Response(result.body, { status: 200, headers: responseHeaders }),
      );
      logCompleted(requestLogger, startedAt, response.status);
      return response;
    }
    if (definition.responseMediaType === 'text/event-stream') {
      throw new Error(`${definition.method} ${definition.path} did not return its event stream`);
    }
    const routeResponse = result instanceof V1HttpResponse ? result : new V1HttpResponse(result);
    if (!definition.successStatuses?.includes(routeResponse.status)) {
      throw new Error(
        `${definition.method} ${definition.path} returned undocumented status ${routeResponse.status}`,
      );
    }
    const output = definition.responseSchema.parse(routeResponse.body);
    const response = withCachePolicy(
      jsonResponse(output, routeResponse.status, requestId, routeResponse.headers),
    );
    logCompleted(requestLogger, startedAt, response.status);
    return response;
  } catch (error) {
    const response = withCachePolicy(mapError(error, requestId));
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

/** Applies the route's declared parameter parsers and rejects undeclared query parameters. */
function parseParameters(
  definition: V1RouteDefinition,
  request: Request,
  pathParams: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const declared = definition.parameters ?? {};
  const query = new URL(request.url).searchParams;
  for (const name of new Set(query.keys())) {
    if (declared[name]?.in !== 'query') throw invalidParameter(name);
  }
  const values: Record<string, unknown> = {};
  for (const [name, parameter] of Object.entries(declared)) {
    const raw =
      parameter.in === 'path'
        ? pathParams[name] === undefined
          ? []
          : [pathParams[name]]
        : query.getAll(name);
    if (raw.length === 0 && parameter.required) throw invalidParameter(name);
    if (raw.length > 1 && !parameter.explode) throw invalidParameter(name);
    try {
      values[name] = parameter.parse(raw);
    } catch (cause) {
      throw invalidParameter(name, cause);
    }
  }
  return values;
}

function invalidParameter(name: string, cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message: 'The request parameters are invalid',
    retryable: false,
    details: { parameter: name },
    cause,
  });
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
    return errorResponse({ ...error.options, requestId });
  }
  if (error instanceof CocodRuntimeError) {
    return errorResponse({ ...mapRuntimeError(error), requestId });
  }
  if (error instanceof IdempotencyKeyConflictError) {
    return errorResponse({
      status: 409,
      code: 'idempotency_key_conflict',
      message: 'The Idempotency-Key was already used for a different request',
      retryable: false,
      requestId,
    });
  }
  if (error instanceof IdempotencyCapacityError) {
    return errorResponse({
      status: 503,
      code: 'idempotency_capacity_exceeded',
      message: 'Idempotency capacity is temporarily unavailable',
      retryable: true,
      headers: { 'Retry-After': '1' },
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

async function executeIdempotent<T>(
  definition: V1RouteDefinition,
  request: Request,
  params: Readonly<Record<string, unknown>>,
  input: unknown,
  operation: () => Promise<T> | T,
  idempotency = new ProcessLocalIdempotency(),
): Promise<T> {
  const key = request.headers.get('idempotency-key');
  if (key === null) {
    return operation();
  }
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_idempotency_key',
      message: 'Idempotency-Key must contain 1 to 255 visible ASCII characters',
      retryable: false,
    });
  }
  definition.assertAvailable?.();
  // The concrete path and parsed parameters identify the target resource, so one key cannot
  // replay a command recorded for a different Operation or Quote.
  const definedParams = Object.fromEntries(
    Object.entries(params).filter(([, value]) => value !== undefined),
  );
  return idempotency.execute(
    key,
    {
      method: definition.method,
      path: new URL(request.url).pathname,
      params: definedParams,
      input,
    },
    operation,
  );
}

function mapRuntimeError(error: CocodRuntimeError): V1HttpErrorOptions {
  const mappings: Partial<
    Record<
      CocodRuntimeErrorCode,
      Pick<V1HttpErrorOptions, 'status' | 'code' | 'message' | 'retryable' | 'headers'>
    >
  > = {
    wallet_already_configured: {
      status: 409,
      code: 'wallet_already_configured',
      message: 'A Wallet is already configured',
      retryable: false,
    },
    wallet_not_configured: {
      status: 409,
      code: 'wallet_not_configured',
      message: 'No Wallet is configured',
      retryable: false,
    },
    passphrase_required: {
      status: 400,
      code: 'passphrase_required',
      message: 'A passphrase is required',
      retryable: false,
    },
    wallet_unlock_failed: {
      status: 401,
      code: 'wallet_unlock_failed',
      message: 'Wallet unlock failed',
      retryable: false,
    },
    session_transition_in_progress: {
      status: 409,
      code: 'session_transition_in_progress',
      message: 'A conflicting Coco Session transition is in progress',
      retryable: true,
      headers: { 'Retry-After': '1' },
    },
    session_restart_required: {
      status: 503,
      code: 'session_restart_required',
      message: 'The Cocod Process must be restarted',
      retryable: false,
    },
  };
  const mapping = mappings[error.code];
  if (!mapping) {
    return {
      status: 500,
      code: 'internal_error',
      message: 'The request could not be completed',
      retryable: false,
      cause: error,
    };
  }
  return { ...mapping, cause: error };
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
