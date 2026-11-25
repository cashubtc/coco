import type { MintRequestBody } from '../../infra/RequestRateLimiter.ts';

/** A mint double reads the body whether cashu-ts hands it over as an object or pre-serialized. */
export function parseRequestBody(
  body: MintRequestBody | undefined,
): Record<string, unknown> | undefined {
  return typeof body === 'string' ? (JSON.parse(body) as Record<string, unknown>) : body;
}
