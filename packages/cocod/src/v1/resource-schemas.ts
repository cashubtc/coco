import { literalNode, namedSchema, objectNode, unionNode } from './schema-nodes.js';

// Family-specific documents belong beside their resource routes; this module owns only shared
// primitives and can re-export those documents as resource families are introduced.

/** A page of a collection selected with `offset` and `limit`. */
export interface PageDocument<T> {
  items: T[];
  offset: number;
  limit: number;
}

/** Commands without inputs accept no body or an empty JSON object. */
export type EmptyCommandRequest = null | Record<string, never>;

/** Rejects anything other than an absolute HTTP(S) URL without credentials. */
export function assertHttpMintUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not contain credentials`);
  }
}

export const emptyCommandRequestSchema = namedSchema<EmptyCommandRequest>(
  'EmptyCommandRequest',
  unionNode([literalNode(null), objectNode({})], 'anyOf'),
);

/** Shallow guard for the generated OpenAPI document served by cocod. */
export const openApiDocumentSchema = namedSchema<Record<string, unknown>>(
  'OpenApiDocument',
  objectNode(
    {
      openapi: literalNode('3.1.0'),
      info: objectNode({}, { additionalProperties: true }),
      paths: objectNode({}, { additionalProperties: true }),
      components: objectNode({}, { additionalProperties: true }),
    },
    { additionalProperties: true },
  ),
);

export * from './resources/wallet-schemas.js';
