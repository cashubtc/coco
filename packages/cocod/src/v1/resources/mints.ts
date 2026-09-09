import { normalizeMintUrl, type Mint } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import {
  knownMintSchema,
  knownMintsSchema,
  mintInformationSchema,
  mintUrlRequestSchema,
  noBodySchema,
  paymentMethodCapabilitiesSchema,
  type KnownMintDocument,
} from '../schema.js';
import { cocoError } from './errors.js';
import {
  MINT_URL_QUERY_PARAMETER,
  TRUSTED_ONLY_QUERY_PARAMETER,
  invalidQuery,
  parseMintUrl,
  parseQuery,
  parseSingleMintUrlQuery,
} from './parameters.js';
import { requireRunningSession } from './session.js';

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

const changeMintTrust = (trusted: boolean) =>
  defineResourceRoute({
    method: 'POST',
    path: `/v1/mints/${trusted ? 'trust' : 'untrust'}`,
    capability: 'wallet:admin',
    requestSchema: mintUrlRequestSchema,
    responseSchema: knownMintSchema,
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
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

export const mintsRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: knownMintsSchema,
    parameters: [TRUSTED_ONLY_QUERY_PARAMETER],
    handler: async (_input, request, { runtime }) => {
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
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/mints',
    capability: 'wallet:admin',
    requestSchema: mintUrlRequestSchema,
    responseSchema: knownMintSchema,
    successStatuses: [200, 201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');

      try {
        const { mint, created } = await session.manager.mint.addMint(mintUrl);
        return new V1HttpResponse(toKnownMintDocument(mint), created ? 201 : 200);
      } catch (error) {
        throw cocoError('register the Mint', error);
      }
    },
  }),
  changeMintTrust(true),
  changeMintTrust(false),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints/info',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: mintInformationSchema,
    parameters: [MINT_URL_QUERY_PARAMETER],
    handler: async (_input, request, { runtime }) => {
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
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints/payment-method-capabilities',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: paymentMethodCapabilitiesSchema,
    parameters: [MINT_URL_QUERY_PARAMETER],
    handler: async (_input, request, { runtime }) => {
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
  }),
];
