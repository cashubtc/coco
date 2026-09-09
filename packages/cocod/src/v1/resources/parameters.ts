import { normalizeMintUrl } from '@cashu/coco-core';
import { V1HttpError, type V1RouteParameter } from '../contract.js';

export const DEFAULT_PAGE_LIMIT = 20;

export const MAX_PAGE_LIMIT = 100;

export const pathParameter = (name: string): V1RouteParameter => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
});

const OFFSET_PARAMETER = {
  name: 'offset',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 0, default: 0 },
} as const satisfies V1RouteParameter;

const LIMIT_PARAMETER = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT },
} as const satisfies V1RouteParameter;

export const PAGE_PARAMETERS = [OFFSET_PARAMETER, LIMIT_PARAMETER] as const;

export const MINT_URL_QUERY_PARAMETER = {
  name: 'mintUrl',
  in: 'query',
  required: true,
  schema: { type: 'string', format: 'uri', pattern: '^https?://' },
} as const satisfies V1RouteParameter;

export const TRUSTED_ONLY_QUERY_PARAMETER = {
  name: 'trustedOnly',
  in: 'query',
  required: false,
  schema: { type: 'boolean' },
} as const satisfies V1RouteParameter;

export function parseSingleMintUrlQuery(request: Request, message: string): string {
  const query = parseQuery(request, [MINT_URL_QUERY_PARAMETER.name], message);
  const values = query.getAll('mintUrl');
  if (values.length !== 1) {
    throw invalidQuery(message);
  }
  return parseMintUrl(values[0]!, message);
}

export function parsePageInteger(
  values: string[],
  minimum: number,
  maximum: number,
  defaultValue: number,
  message: string,
): number {
  if (values.length === 0) return defaultValue;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0]!)) throw invalidQuery(message);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidQuery(message);
  }
  return value;
}

export function parseMintUrl(value: string, message: string): string {
  try {
    if (value.length === 0) {
      throw new Error('Mint URL is empty');
    }
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Mint URL must use HTTP or HTTPS');
    }
    return normalizeMintUrl(value);
  } catch (error) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message,
      retryable: false,
      cause: error,
    });
  }
}

export function compareOperationsForPagination<T extends { createdAt: number; id: string }>(
  left: T,
  right: T,
): number {
  return left.createdAt !== right.createdAt
    ? right.createdAt - left.createdAt
    : left.id.localeCompare(right.id);
}

export function parsePathIdentity(
  request: Request,
  prefix: string,
  suffix: string,
  message: string,
): string {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw invalidQuery(message);
  const encoded = path.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
  try {
    const identity = decodeURIComponent(encoded);
    if (identity.length === 0 || identity.includes('/')) throw new Error('Invalid identity');
    return identity;
  } catch (error) {
    throw invalidQuery(message, error);
  }
}

export function parseQuery(request: Request, allowedKeys: readonly string[], message: string) {
  const query = new URL(request.url).searchParams;
  const allowed = new Set(allowedKeys);
  if (Array.from(query.keys()).some((key) => !allowed.has(key))) {
    throw invalidQuery(message);
  }
  return query;
}

export function queryParameterNames(parameters: readonly V1RouteParameter[]): string[] {
  return parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name);
}

export function invalidQuery(message: string, cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message,
    retryable: false,
    cause,
  });
}
