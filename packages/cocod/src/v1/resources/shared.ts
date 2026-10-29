import { normalizeMintUrl } from '@cashu/coco-core';

import type { RunningCocoSession } from '../../runtime.js';
import type { AppLogger } from '../../utils/logger.js';
import {
  defineV1Route,
  V1HttpError,
  type V1Parameter,
  type V1Parameters,
  type V1RequestContext,
  type V1RouteDefinition,
  type V1RouteMetadata,
  type V1Runtime,
} from '../contract.js';
import type { PageDocument } from '../resource-schemas.js';

/** Host dependencies bound to Wallet resource routes by the HTTP composition root. */
export interface ResourceDependencies {
  readonly runtime: V1Runtime;
  readonly daemonVersion: string;
  readonly logger?: AppLogger;
  /** Interval between event-stream keep-alives, which also re-check the Client Credential. */
  readonly eventKeepAliveIntervalMs: number;
}

/** A route whose metadata is static and whose handler is bound to host dependencies later. */
export interface ResourceRoute {
  readonly metadata: V1RouteMetadata;
  bind(dependencies: ResourceDependencies): V1RouteDefinition;
}

type ResourceHandler<TRequest, TResponse, P extends V1Parameters> = (
  input: TRequest,
  context: V1RequestContext<P>,
  dependencies: ResourceDependencies,
) => ReturnType<V1RouteDefinition<TRequest, TResponse, P>['handler']>;

/** Declares one Wallet resource route; the same declaration drives HTTP and OpenAPI. */
export function defineResourceRoute<
  TRequest,
  TResponse,
  P extends V1Parameters = Record<never, never>,
>(
  route: V1RouteMetadata<TRequest, TResponse, P> & {
    handler: ResourceHandler<TRequest, TResponse, P>;
  },
): ResourceRoute {
  const { handler, ...metadata } = route;
  const unbound = defineV1Route<TRequest, TResponse, P>({
    ...metadata,
    handler: () => {
      throw new Error(`${route.method} ${route.path} is not bound to host dependencies`);
    },
  });
  const { handler: _unboundHandler, ...normalizedMetadata } = unbound;
  return {
    metadata: normalizedMetadata,
    bind: (dependencies) =>
      defineV1Route<TRequest, TResponse, P>({
        ...metadata,
        handler: (input, context) => handler(input, context, dependencies),
      }),
  };
}

/**
 * Returns the running Coco Session or the lifecycle error the network interface specifies for
 * Wallet-dependent requests in the current state.
 */
export function requireRunningSession(runtime: V1Runtime): RunningCocoSession {
  const session = runtime.getRunningSession();
  if (session) return session;

  const status = runtime.getStatus();
  if (!status.wallet) {
    throw new V1HttpError({
      status: 409,
      code: 'wallet_not_configured',
      message: 'No Wallet is configured',
      retryable: false,
    });
  }
  const state = status.cocoSession.state;
  if (state === 'starting' || state === 'stopping') {
    throw new V1HttpError({
      status: 503,
      code: 'session_transition_in_progress',
      message: `The Coco Session is ${state}`,
      retryable: true,
      details: { state },
      headers: { 'Retry-After': '1' },
    });
  }
  if (state === 'failed') {
    throw new V1HttpError({
      status: 503,
      code: 'session_restart_required',
      message: 'The Cocod Process must be restarted',
      retryable: false,
    });
  }
  if (status.seedAccess?.state === 'locked') {
    throw new V1HttpError({
      status: 423,
      code: 'wallet_locked',
      message: 'Wallet Seed Access is locked',
      retryable: false,
    });
  }
  // An explicit stop stays in effect until an administrator starts the Coco Session again.
  throw new V1HttpError({
    status: 503,
    code: 'session_stopped',
    message: 'The Coco Session is stopped',
    retryable: false,
  });
}

export function notFound(message: string, details?: Record<string, unknown>): V1HttpError {
  return new V1HttpError({ status: 404, code: 'not_found', message, retryable: false, details });
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Required path segment such as an Operation ID or Quote ID. */
export function pathIdentifier(description: string): V1Parameter<string> {
  return {
    in: 'path',
    required: true,
    description,
    schema: { type: 'string', minLength: 1, maxLength: 512 },
    parse([value]) {
      if (!value || value.length > 512 || value.includes('�')) {
        throw new Error('invalid identifier');
      }
      return value;
    },
  };
}

function queryInteger(minimum: number, maximum: number, fallback: number): V1Parameter<number> {
  return {
    in: 'query',
    required: false,
    schema: { type: 'integer', minimum, maximum, default: fallback },
    parse([value]) {
      if (value === undefined) return fallback;
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('not a decimal integer');
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error('out of range');
      }
      return parsed;
    },
  };
}

export const pageParameters = {
  offset: queryInteger(0, Number.MAX_SAFE_INTEGER, 0),
  limit: queryInteger(1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT),
} as const;

export function queryBoolean(description: string): V1Parameter<boolean | undefined> {
  return {
    in: 'query',
    required: false,
    description,
    schema: { type: 'boolean' },
    parse([value]) {
      if (value === undefined) return undefined;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error('not a boolean');
    },
  };
}

export function queryEnum<const T extends readonly string[]>(
  values: T,
  description: string,
): V1Parameter<T[number] | undefined> {
  return {
    in: 'query',
    required: false,
    description,
    schema: { type: 'string', enum: values },
    parse([value]) {
      if (value === undefined) return undefined;
      if (!values.includes(value)) throw new Error('unsupported value');
      return value as T[number];
    },
  };
}

/** A Mint URL query parameter, normalized to Coco's Known Mint identity. */
export function queryMintUrl(description: string): V1Parameter<string> {
  return {
    in: 'query',
    required: true,
    description,
    schema: { type: 'string', format: 'uri', pattern: '^https?://' },
    parse([value]) {
      return normalizeRequestMintUrl(value ?? '');
    },
  };
}

/** Repeatable Mint URL filter such as `?mintUrl=a&mintUrl=b`. */
export function queryMintUrls(description: string): V1Parameter<string[]> {
  return {
    in: 'query',
    required: false,
    explode: true,
    description,
    schema: { type: 'array', items: { type: 'string', format: 'uri', pattern: '^https?://' } },
    parse: (values) => values.map(normalizeRequestMintUrl),
  };
}

/** Repeatable non-empty string filter such as `?unit=sat&unit=usd`. */
export function queryStrings(description: string): V1Parameter<string[]> {
  return {
    in: 'query',
    required: false,
    explode: true,
    description,
    schema: { type: 'array', items: { type: 'string', minLength: 1 } },
    parse(values) {
      if (values.some((value) => value.length === 0)) throw new Error('empty value');
      return [...values];
    },
  };
}

/** Normalizes an absolute HTTP(S) Mint URL that a request schema or parameter accepted. */
export function normalizeRequestMintUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Mint URL must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) throw new Error('Mint URL must not contain credentials');
  return normalizeMintUrl(value);
}

// ---------------------------------------------------------------------------
// Representation helpers
// ---------------------------------------------------------------------------

/** Formats a Coco millisecond timestamp. */
export function fromMillis(value: number): string {
  return new Date(value).toISOString();
}

/** Formats a Coco or Mint second timestamp. */
export function fromSeconds(value: number): string {
  return new Date(value * 1_000).toISOString();
}

/**
 * Selects one page of a complete Coco collection, newest first with the ID as a stable tie
 * breaker. Pages are not a snapshot: concurrent changes may shift later pages.
 */
export function paginate<T, D>(
  items: readonly T[],
  key: (item: T) => { createdAt: number; id: string },
  toDocument: (item: T) => D,
  { offset, limit }: { offset: number; limit: number },
): PageDocument<D> {
  const ordered = items.toSorted((left, right) => {
    const a = key(left);
    const b = key(right);
    return a.createdAt !== b.createdAt ? b.createdAt - a.createdAt : a.id.localeCompare(b.id);
  });
  return { items: ordered.slice(offset, offset + limit).map(toDocument), offset, limit };
}
