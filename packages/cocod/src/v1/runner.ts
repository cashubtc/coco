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

type BunRouteHandlers = Record<
  string,
  {
    GET?: (request: Request) => Promise<Response>;
    POST?: (request: Request) => Promise<Response>;
  }
>;

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
    const runtimePath = definition.path.replaceAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, ':$1');
    const handlers = (routes[runtimePath] ??= {});
    handlers[definition.method] = (request) =>
      runV1Route(definition, request, credentials, logger, {
        idempotency,
        isAcceptingWork: options.isAcceptingWork,
      });
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
  const unsupportedQuoteTypeRoute = defineV1Route<null, never>({
    method: 'GET',
    path: '/v1/quotes/{type}',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: noSuccessResponseSchema,
    handler: (_input, request) => {
      const type = unsupportedQuoteType(new URL(request.url).pathname);
      if (type === null) {
        throw new Error('Unsupported Quote type route received a supported path');
      }
      throw new V1HttpError({
        status: 409,
        code: 'unsupported_behavior',
        message: 'The Quote type is unsupported',
        retryable: false,
        details: { type },
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
      const route = unsupportedQuoteType(path) === null ? notFoundRoute : unsupportedQuoteTypeRoute;
      return runV1Route(route, request, credentials, logger, {
        requestPath: path,
        skipRequestParsing: true,
      });
    }
    return legacyFallback(request);
  };
}

function unsupportedQuoteType(path: string): string | null {
  const prefix = '/v1/quotes/';
  if (!path.startsWith(prefix)) return null;
  const encodedType = path.slice(prefix.length).split('/', 1)[0];
  if (!encodedType) return null;
  let type: string;
  try {
    type = decodeURIComponent(encodedType);
  } catch {
    type = encodedType;
  }
  return type === 'mint' || type === 'melt' ? null : type;
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
  } = {},
): Promise<Response> {
  const startedAt = performance.now();
  const requestId = crypto.randomUUID();
  const requestPath = options.requestPath ?? definition.path;
  const authorizationHeader = request.headers.get('authorization');
  const requestLogger =
    logger?.child?.({ method: request.method, path: requestPath, requestId }) ?? logger;

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
        if (definition.responseCacheControl) {
          response.headers.set('Cache-Control', definition.responseCacheControl);
        }
        logCompleted(requestLogger, startedAt, response.status);
        return response;
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

    const input = options.skipRequestParsing
      ? null
      : await parseRequest(request, definition.requestSchema);
    requestLogger?.debug('request.received', { input: redactLogValue(input) });
    const invokeHandler = () =>
      definition.handler(input, request, {
        reauthorize: async () =>
          definition.capability === null ||
          (await credentials.authorize(authorizationHeader, definition.capability)) ===
            'authorized',
      });
    const result =
      definition.idempotencyKey === 'optional'
        ? await executeIdempotent(definition, request, input, invokeHandler, options.idempotency)
        : await invokeHandler();
    if (result instanceof V1HttpStreamResponse) {
      if (definition.responseMediaType !== 'text/event-stream') {
        throw new Error(`${definition.method} ${definition.path} returned an undocumented stream`);
      }
      if (!definition.successStatuses?.includes(result.status)) {
        throw new Error(
          `${definition.method} ${definition.path} returned undocumented status ${result.status}`,
        );
      }
      const responseHeaders = new Headers(result.headers);
      responseHeaders.set('Content-Type', definition.responseMediaType);
      responseHeaders.set('X-Request-ID', requestId);
      if (definition.responseCacheControl) {
        responseHeaders.set('Cache-Control', definition.responseCacheControl);
      }
      const response = new Response(result.body, {
        status: result.status,
        headers: responseHeaders,
      });
      logCompleted(requestLogger, startedAt, response.status);
      return response;
    }
    const routeResponse = result instanceof V1HttpResponse ? result : new V1HttpResponse(result);
    if (!definition.successStatuses?.includes(routeResponse.status)) {
      throw new Error(
        `${definition.method} ${definition.path} returned undocumented status ${routeResponse.status}`,
      );
    }
    const output = definition.responseSchema.parse(routeResponse.body);
    const responseHeaders = new Headers(routeResponse.headers);
    if (definition.responseCacheControl) {
      responseHeaders.set('Cache-Control', definition.responseCacheControl);
    }
    const response = jsonResponse(output, routeResponse.status, requestId, responseHeaders);
    logCompleted(requestLogger, startedAt, response.status);
    return response;
  } catch (error) {
    const response = mapError(error, requestId);
    if (definition.responseCacheControl) {
      response.headers.set('Cache-Control', definition.responseCacheControl);
    }
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
  const url = new URL(request.url);
  const query = Array.from(url.searchParams.entries()).toSorted(
    ([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyComparison = leftKey.localeCompare(rightKey);
      return keyComparison !== 0 ? keyComparison : leftValue.localeCompare(rightValue);
    },
  );
  return idempotency.execute(
    key,
    { method: definition.method, path: url.pathname, query, input },
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
