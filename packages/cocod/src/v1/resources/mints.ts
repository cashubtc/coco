import { normalizeMintUrl, type Mint } from '@cashu/coco-core';
import { cocoError } from './errors.js';
import {
  defineV1Route,
  V1HttpError,
  V1HttpResponse,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from '../contract.js';
import {
  knownMintSchema,
  knownMintsSchema,
  mintInformationSchema,
  mintUrlRequestSchema,
  paymentMethodCapabilitiesSchema,
  noBodySchema,
  type KnownMintDocument,
  type KnownMintsDocument,
  type MintInformationDocument,
  type MintUrlRequest,
  type PaymentMethodCapabilitiesDocument,
} from '../schema.js';
import { requireRunningSession } from './session.js';
import {
  TRUSTED_ONLY_QUERY_PARAMETER,
  parseQuery,
  invalidQuery,
  parseMintUrl,
  MINT_URL_QUERY_PARAMETER,
  parseSingleMintUrlQuery,
} from './parameters.js';

const CREATE_MINT_ROUTE = {
  method: 'POST',
  path: '/v1/mints',
  capability: 'wallet:admin',
  requestSchema: mintUrlRequestSchema,
  responseSchema: knownMintSchema,
  successStatuses: [200, 201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<MintUrlRequest, KnownMintDocument>;

const LIST_MINTS_ROUTE = {
  method: 'GET',
  path: '/v1/mints',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: knownMintsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [TRUSTED_ONLY_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, KnownMintsDocument>;

const TRUST_MINT_ROUTE = {
  method: 'POST',
  path: '/v1/mints/trust',
  capability: 'wallet:admin',
  requestSchema: mintUrlRequestSchema,
  responseSchema: knownMintSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<MintUrlRequest, KnownMintDocument>;

const UNTRUST_MINT_ROUTE = {
  ...TRUST_MINT_ROUTE,
  path: '/v1/mints/untrust',
} as const satisfies V1RouteMetadata<MintUrlRequest, KnownMintDocument>;

const MINT_INFO_ROUTE = {
  method: 'GET',
  path: '/v1/mints/info',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintInformationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, MintInformationDocument>;

const PAYMENT_METHOD_CAPABILITIES_ROUTE = {
  method: 'GET',
  path: '/v1/mints/payment-method-capabilities',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: paymentMethodCapabilitiesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, PaymentMethodCapabilitiesDocument>;

function toJsonObject(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  const parsed: unknown = serialized === undefined ? null : JSON.parse(serialized);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Coco returned invalid Mint information');
  }
  return parsed as Record<string, unknown>;
}

async function findKnownMint(
  mintApi: { getAllMints(): Promise<Mint[]> },
  mintUrl: string,
): Promise<Mint | undefined> {
  return (await mintApi.getAllMints()).find((mint) => normalizeMintUrl(mint.mintUrl) === mintUrl);
}

function parseTrustedOnly(request: Request, message: string): boolean {
  const query = parseQuery(request, [TRUSTED_ONLY_QUERY_PARAMETER.name], message);
  const values = query.getAll('trustedOnly');
  if (values.length > 1 || values.some((value) => value !== 'true' && value !== 'false')) {
    throw invalidQuery(message);
  }
  return values[0] === 'true';
}

function toKnownMintDocument(mint: Mint): KnownMintDocument {
  return {
    mintUrl: normalizeMintUrl(mint.mintUrl),
    name: mint.name,
    trusted: mint.trusted,
    createdAt: new Date(mint.createdAt * 1_000).toISOString(),
    updatedAt: new Date(mint.updatedAt * 1_000).toISOString(),
  };
}

function knownMintNotFound(): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Known Mint does not exist',
    retryable: false,
  });
}

export const mintsMetadata = [
  LIST_MINTS_ROUTE,
  CREATE_MINT_ROUTE,
  TRUST_MINT_ROUTE,
  UNTRUST_MINT_ROUTE,
  MINT_INFO_ROUTE,
  PAYMENT_METHOD_CAPABILITIES_ROUTE,
];

export function createMintsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const createMint = defineV1Route({
    ...CREATE_MINT_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');

      try {
        const { mint, created } = await session.manager.mint.addMint(mintUrl);
        return new V1HttpResponse(toKnownMintDocument(mint), created ? 201 : 200);
      } catch (error) {
        throw cocoError('register the Mint', error);
      }
    },
  });
  const listMints = defineV1Route({
    ...LIST_MINTS_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const trustedOnly = parseTrustedOnly(request, 'The Known Mint filters are invalid');
      try {
        const mints = trustedOnly
          ? await session.manager.mint.getAllTrustedMints()
          : await session.manager.mint.getAllMints();
        return { items: mints.map(toKnownMintDocument) };
      } catch (error) {
        throw cocoError('list Known Mints', error);
      }
    },
  });
  const changeMintTrust = (
    route: typeof TRUST_MINT_ROUTE | typeof UNTRUST_MINT_ROUTE,
    trusted: boolean,
  ) =>
    defineV1Route({
      ...route,
      handler: async (input) => {
        const session = requireRunningSession(runtime);
        const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
        try {
          const existing = await findKnownMint(session.manager.mint, mintUrl);
          if (!existing) {
            throw knownMintNotFound();
          }
          if (trusted) {
            await session.manager.mint.trustMint(mintUrl);
          } else {
            await session.manager.mint.untrustMint(mintUrl);
          }
          const updated = await findKnownMint(session.manager.mint, mintUrl);
          if (!updated) {
            throw new Error('Coco did not return the Known Mint after changing trust');
          }
          return toKnownMintDocument(updated);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw cocoError(`${trusted ? 'trust' : 'untrust'} the Mint`, error);
        }
      },
    });
  const trustMint = changeMintTrust(TRUST_MINT_ROUTE, true);
  const untrustMint = changeMintTrust(UNTRUST_MINT_ROUTE, false);
  const mintInfo = defineV1Route({
    ...MINT_INFO_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseSingleMintUrlQuery(request, 'The Mint information query is invalid');
      try {
        if (!(await findKnownMint(session.manager.mint, mintUrl))) {
          throw knownMintNotFound();
        }
        const info = await session.manager.mint.getMintInfo(mintUrl);
        return { mintUrl, info: toJsonObject(info) };
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw cocoError('return Mint information', error);
      }
    },
  });
  const paymentMethodCapabilities = defineV1Route({
    ...PAYMENT_METHOD_CAPABILITIES_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseSingleMintUrlQuery(
        request,
        'The Payment Method Capability query is invalid',
      );
      try {
        if (!(await findKnownMint(session.manager.mint, mintUrl))) {
          throw knownMintNotFound();
        }
        const capabilities = await session.manager.mint.listPaymentMethodCapabilities({ mintUrl });
        return {
          items: capabilities.map((capability) => ({
            operation: capability.operation,
            nut: capability.nut,
            method: capability.method,
            unit: capability.unit,
            ...(capability.minAmount !== undefined
              ? { minAmount: capability.minAmount?.toString() ?? null }
              : {}),
            ...(capability.maxAmount !== undefined
              ? { maxAmount: capability.maxAmount?.toString() ?? null }
              : {}),
            ...(capability.options !== undefined
              ? { options: JSON.parse(JSON.stringify(capability.options)) as unknown }
              : {}),
          })),
        };
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw cocoError('return Payment Method Capabilities', error);
      }
    },
  });
  return [listMints, createMint, trustMint, untrustMint, mintInfo, paymentMethodCapabilities];
}
