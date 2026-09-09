import { normalizeMintUrl, type MeltQuote, type MintQuote } from '@cashu/coco-core';
import { V1HttpError, V1HttpResponse, type V1RouteParameter } from '../contract.js';
import { defineResourceRoute, type ResourceRoute } from '../resource.js';
import {
  createMeltQuoteRequestSchema,
  createMintQuoteRequestSchema,
  meltQuoteSchema,
  mintQuoteSchema,
  noBodySchema,
  pendingMeltQuotesSchema,
  pendingMintQuotesSchema,
  type MeltQuoteDocument,
  type MintQuoteDocument,
  type RuntimeSchema,
} from '../schema.js';
import { cocoError, quoteNotFound } from './errors.js';
import {
  DEFAULT_PAGE_LIMIT,
  invalidQuery,
  MAX_PAGE_LIMIT,
  MINT_URL_QUERY_PARAMETER,
  PAGE_PARAMETERS,
  parseMintUrl,
  parsePageInteger,
  parsePathIdentity,
  parseQuery,
  parseSingleMintUrlQuery,
  pathParameter,
  queryParameterNames,
} from './parameters.js';
import { requireRunningSession, type RunningSession } from './session.js';

const QUOTE_METHOD_QUERY_PARAMETER = {
  name: 'method',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: ['bolt11', 'bolt12', 'onchain'] },
} as const satisfies V1RouteParameter;

type QuoteIdentityInput = { mintUrl: string; quoteId: string };

type BuiltInQuoteMethod = 'bolt11' | 'bolt12' | 'onchain';

type PaginatedQuote = { createdAt: number; mintUrl: string; quoteId: string; method: string };

interface QuoteReadAdapter<TQuote> {
  get(identity: QuoteIdentityInput): Promise<TQuote | null>;
  listPending(input?: { method?: BuiltInQuoteMethod }): Promise<TQuote[]>;
  refresh(identity: QuoteIdentityInput): Promise<TQuote>;
}

function createQuoteReadRouteDefinitions<TQuote extends PaginatedQuote, TDocument>(options: {
  type: 'mint' | 'melt';
  schema: RuntimeSchema<TDocument>;
  collectionSchema: RuntimeSchema<{ items: TDocument[]; offset: number; limit: number }>;
  getAdapter(session: RunningSession): QuoteReadAdapter<TQuote>;
  toDocument(quote: TQuote): TDocument;
}): ResourceRoute[] {
  const { type, schema, collectionSchema, getAdapter, toDocument } = options;
  const label = type === 'mint' ? 'Mint' : 'Melt';
  const list = defineResourceRoute({
    method: 'GET',
    path: `/v1/quotes/${type}/pending`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: collectionSchema,
    parameters: [QUOTE_METHOD_QUERY_PARAMETER, ...PAGE_PARAMETERS],
    handler: async (_input, request, { runtime }) => {
      const adapter = getAdapter(requireRunningSession(runtime));
      const { method, offset, limit } = parsePendingQuoteQuery(request, type);
      try {
        const quotes = method ? await adapter.listPending({ method }) : await adapter.listPending();
        const items = quotes
          .toSorted(compareQuotesForPagination)
          .slice(offset, offset + limit)
          .map(toDocument);
        return { items, offset, limit };
      } catch (error) {
        throw cocoError(`list pending ${label} Quotes`, error);
      }
    },
  });
  const get = defineResourceRoute({
    method: 'GET',
    path: `/v1/quotes/${type}/{quoteId}`,
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: schema,
    parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
    handler: async (_input, request, { runtime }) => {
      const adapter = getAdapter(requireRunningSession(runtime));
      const identity = parseQuoteIdentity(request, type, false);
      try {
        const quote = await adapter.get(identity);
        if (!quote) throw quoteNotFound(label);
        return toDocument(quote);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw cocoError(`return the ${label} Quote`, error);
      }
    },
  });
  const refresh = defineResourceRoute({
    method: 'POST',
    path: `/v1/quotes/${type}/{quoteId}/refresh`,
    capability: 'wallet:admin',
    requestSchema: noBodySchema,
    responseSchema: schema,
    idempotencyKey: 'optional',
    parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
    handler: async (_input, request, { runtime }) => {
      const adapter = getAdapter(requireRunningSession(runtime));
      const identity = parseQuoteIdentity(request, type, true);
      try {
        if (!(await adapter.get(identity))) throw quoteNotFound(label);
        return toDocument(await adapter.refresh(identity));
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw cocoError(`reconcile the ${label} Quote`, error);
      }
    },
  });
  return [list, get, refresh];
}

function parseQuoteIdentity(
  request: Request,
  type: 'mint' | 'melt',
  refresh: boolean,
): QuoteIdentityInput {
  const label = type === 'mint' ? 'Mint' : 'Melt';
  return {
    mintUrl: parseSingleMintUrlQuery(request, `The ${label} Quote identity is invalid`),
    quoteId: parseQuoteIdPath(request, type, refresh),
  };
}

function parsePendingQuoteQuery(
  request: Request,
  type: 'mint' | 'melt',
): { method?: 'bolt11' | 'bolt12' | 'onchain'; offset: number; limit: number } {
  const message = `The pending ${type === 'mint' ? 'Mint' : 'Melt'} Quote filters are invalid`;
  const parameters = [QUOTE_METHOD_QUERY_PARAMETER, ...PAGE_PARAMETERS];
  const query = parseQuery(request, queryParameterNames(parameters), message);
  const methods = query.getAll('method');
  if (
    methods.length > 1 ||
    methods.some((method) => method !== 'bolt11' && method !== 'bolt12' && method !== 'onchain')
  ) {
    throw invalidQuery(message);
  }
  return {
    ...(methods[0] ? { method: methods[0] as 'bolt11' | 'bolt12' | 'onchain' } : {}),
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function toMintQuoteDocument(quote: MintQuote): MintQuoteDocument {
  const base = {
    type: 'mint' as const,
    mintUrl: normalizeMintUrl(quote.mintUrl),
    quoteId: quote.quoteId,
    request: quote.request,
    unit: quote.unit,
    amountPaid: quote.amountPaid.toString(),
    amountIssued: quote.amountIssued.toString(),
    expiry: quote.expiry === null ? null : new Date(quote.expiry * 1_000).toISOString(),
    createdAt: new Date(quote.createdAt).toISOString(),
    updatedAt: new Date(quote.updatedAt).toISOString(),
  };

  if (quote.method === 'bolt11') {
    return {
      ...base,
      method: quote.method,
      amount: quote.amount.toString(),
      reusable: false,
      state: quote.state,
    };
  }
  if (quote.method === 'bolt12') {
    return {
      ...base,
      method: quote.method,
      ...(quote.amount !== undefined ? { amount: quote.amount.toString() } : {}),
      reusable: true,
    };
  }
  return { ...base, method: quote.method, reusable: true };
}

function toMeltQuoteDocument(quote: MeltQuote): MeltQuoteDocument {
  const base = {
    type: 'melt' as const,
    mintUrl: normalizeMintUrl(quote.mintUrl),
    quoteId: quote.quoteId,
    request: quote.request,
    unit: quote.unit,
    amount: quote.amount.toString(),
    state: quote.state,
    expiry: new Date(quote.expiry * 1_000).toISOString(),
    createdAt: new Date(quote.createdAt).toISOString(),
    updatedAt: new Date(quote.updatedAt).toISOString(),
  };

  if (quote.method === 'onchain') {
    return {
      ...base,
      method: quote.method,
      feeOptions: quote.fee_options.map((option) => ({
        feeIndex: option.fee_index,
        feeReserve: option.fee_reserve.toString(),
        estimatedBlocks: option.estimated_blocks,
      })),
    };
  }
  return { ...base, method: quote.method, feeReserve: quote.fee_reserve.toString() };
}

function compareQuotesForPagination(
  left: { createdAt: number; mintUrl: string; quoteId: string; method: string },
  right: { createdAt: number; mintUrl: string; quoteId: string; method: string },
): number {
  if (left.createdAt !== right.createdAt) return right.createdAt - left.createdAt;
  const mintComparison = normalizeMintUrl(left.mintUrl).localeCompare(
    normalizeMintUrl(right.mintUrl),
  );
  if (mintComparison !== 0) return mintComparison;
  const quoteComparison = left.quoteId.localeCompare(right.quoteId);
  return quoteComparison !== 0 ? quoteComparison : left.method.localeCompare(right.method);
}

function parseQuoteIdPath(request: Request, type: 'mint' | 'melt', refresh: boolean): string {
  const prefix = `/v1/quotes/${type}/`;
  const suffix = refresh ? '/refresh' : '';
  const message = `The ${type === 'mint' ? 'Mint' : 'Melt'} Quote identity is invalid`;
  return parsePathIdentity(request, prefix, suffix, message);
}

export const quotesRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/quotes/mint',
    capability: 'wallet:admin',
    requestSchema: createMintQuoteRequestSchema,
    responseSchema: mintQuoteSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined
          ? session.mintUrl
          : parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const quote = await session.manager.quotes.mint.create(
          input.method === 'bolt11'
            ? {
                mintUrl,
                method: input.method,
                amount: input.amount,
                unit: input.unit,
                ...(input.locked === true ? { locked: true } : {}),
              }
            : input.method === 'bolt12'
              ? {
                  mintUrl,
                  method: input.method,
                  unit: input.unit,
                  ...(input.amount !== undefined ? { amount: input.amount } : {}),
                  ...(input.description !== undefined ? { description: input.description } : {}),
                }
              : { mintUrl, method: input.method, unit: input.unit },
        );
        return new V1HttpResponse(toMintQuoteDocument(quote), 201);
      } catch (error) {
        throw cocoError('create the Mint Quote', error);
      }
    },
  }),
  ...createQuoteReadRouteDefinitions({
    type: 'mint',
    schema: mintQuoteSchema,
    collectionSchema: pendingMintQuotesSchema,
    getAdapter: (session) => session.manager.quotes.mint,
    toDocument: toMintQuoteDocument,
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/quotes/melt',
    capability: 'wallet:admin',
    requestSchema: createMeltQuoteRequestSchema,
    responseSchema: meltQuoteSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined
          ? session.mintUrl
          : parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const methodData =
          input.method === 'bolt11'
            ? {
                invoice: input.invoice,
                ...(input.amount !== undefined ? { amountSats: input.amount } : {}),
              }
            : input.method === 'bolt12'
              ? {
                  offer: input.offer,
                  ...(input.amount !== undefined ? { amountSats: input.amount } : {}),
                }
              : { address: input.address, amountSats: input.amount };
        const quote = await session.manager.quotes.melt.create({
          mintUrl,
          method: input.method,
          methodData,
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
        } as Parameters<typeof session.manager.quotes.melt.create>[0]);
        return new V1HttpResponse(toMeltQuoteDocument(quote), 201);
      } catch (error) {
        throw cocoError('create the Melt Quote', error);
      }
    },
  }),
  ...createQuoteReadRouteDefinitions({
    type: 'melt',
    schema: meltQuoteSchema,
    collectionSchema: pendingMeltQuotesSchema,
    getAdapter: (session) => session.manager.quotes.melt,
    toDocument: toMeltQuoteDocument,
  }),
];
