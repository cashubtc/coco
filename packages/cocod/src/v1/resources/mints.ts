import type { Manager, Mint } from '@cashu/coco-core';

import { noBodySchema } from '../schema.js';
import {
  knownMintSchema,
  knownMintsSchema,
  mintInformationSchema,
  mintTrustRequestSchema,
  paymentMethodCapabilitiesSchema,
  registerMintRequestSchema,
  type KnownMintDocument,
} from '../resource-schemas.js';
import { withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromSeconds,
  normalizeRequestMintUrl,
  notFound,
  queryBoolean,
  queryMintUrl,
  requireRunningSession,
} from './shared.js';

function toKnownMintDocument(mint: Mint): KnownMintDocument {
  return {
    mintUrl: mint.mintUrl,
    name: mint.name,
    trusted: mint.trusted,
    createdAt: fromSeconds(mint.createdAt),
    updatedAt: fromSeconds(mint.updatedAt),
  };
}

/** Reads the stored Known Mint without contacting the Mint. */
async function findKnownMint(manager: Manager, mintUrl: string): Promise<Mint | undefined> {
  const mints = await withCocoErrors({ action: 'read Known Mints' }, () =>
    manager.mint.getAllMints(),
  );
  return mints.find((mint) => mint.mintUrl === mintUrl);
}

async function requireKnownMint(manager: Manager, mintUrl: string): Promise<Mint> {
  const mint = await findKnownMint(manager, mintUrl);
  if (!mint) throw notFound('The Known Mint does not exist', { mintUrl });
  return mint;
}

function changeTrustRoute(trusted: boolean) {
  return defineResourceRoute({
    method: 'POST',
    path: trusted ? '/v1/mints/trust' : '/v1/mints/untrust',
    capability: 'wallet:admin',
    summary: trusted ? 'Trust a Known Mint' : 'Stop trusting a Known Mint',
    requestSchema: mintTrustRequestSchema,
    responseSchema: knownMintSchema,
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const mintUrl = normalizeRequestMintUrl(input.mintUrl);
      await requireKnownMint(manager, mintUrl);
      await withCocoErrors({ action: 'change Mint trust' }, () =>
        trusted ? manager.mint.trustMint(mintUrl) : manager.mint.untrustMint(mintUrl),
      );
      return toKnownMintDocument(await requireKnownMint(manager, mintUrl));
    },
  });
}

export const mintRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints',
    capability: 'wallet:read',
    summary: 'List Known Mints',
    requestSchema: noBodySchema,
    responseSchema: knownMintsSchema,
    parameters: { trustedOnly: queryBoolean('List only trusted Known Mints.') },
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const mints = await withCocoErrors({ action: 'read Known Mints' }, () =>
        params.trustedOnly ? manager.mint.getAllTrustedMints() : manager.mint.getAllMints(),
      );
      return { items: mints.map(toKnownMintDocument) };
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/mints',
    capability: 'wallet:admin',
    summary: 'Register a Known Mint, optionally setting its trust',
    requestSchema: registerMintRequestSchema,
    responseSchema: knownMintSchema,
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const mintUrl = normalizeRequestMintUrl(input.mintUrl);
      // Omitting `trusted` keeps an existing trust decision; a new Known Mint starts untrusted.
      const { mint } = await withCocoErrors({ action: 'register the Mint' }, () =>
        manager.mint.addMint(
          mintUrl,
          input.trusted === undefined ? undefined : { trusted: input.trusted },
        ),
      );
      return toKnownMintDocument(mint);
    },
  }),
  changeTrustRoute(true),
  changeTrustRoute(false),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints/info',
    capability: 'wallet:read',
    summary: 'Mint information of a Known Mint',
    requestSchema: noBodySchema,
    responseSchema: mintInformationSchema,
    parameters: { mintUrl: queryMintUrl('Known Mint URL.') },
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      await requireKnownMint(manager, params.mintUrl);
      // Coco may refresh stale metadata from the Mint while resolving this read.
      const info = await withCocoErrors({ action: 'read Mint information' }, () =>
        manager.mint.getMintInfo(params.mintUrl),
      );
      return { mintUrl: params.mintUrl, info: toJsonObject(info) };
    },
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/mints/payment-method-capabilities',
    capability: 'wallet:read',
    summary: 'Enabled NUT-04 and NUT-05 methods and units of a Known Mint',
    requestSchema: noBodySchema,
    responseSchema: paymentMethodCapabilitiesSchema,
    parameters: { mintUrl: queryMintUrl('Known Mint URL.') },
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      await requireKnownMint(manager, params.mintUrl);
      const capabilities = await withCocoErrors(
        { action: 'read Payment Method Capabilities' },
        () => manager.mint.listPaymentMethodCapabilities({ mintUrl: params.mintUrl }),
      );
      return {
        mintUrl: params.mintUrl,
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
          ...(capability.options !== undefined ? { options: toJsonValue(capability.options) } : {}),
        })),
      };
    },
  }),
];

/** Mint-supplied data is passed through as plain JSON. */
function toJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : (JSON.parse(serialized) as unknown);
}

function toJsonObject(value: unknown): Record<string, unknown> {
  const json = toJsonValue(value);
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Coco returned Mint information that is not an object');
  }
  return json as Record<string, unknown>;
}
