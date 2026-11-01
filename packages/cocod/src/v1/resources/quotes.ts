import type { Manager, MeltQuote, MintQuote } from '@cashu/coco-core';

import { V1HttpResponse } from '../contract.js';
import { noBodySchema } from '../schema.js';
import {
  createMeltQuoteRequestSchema,
  createMintQuoteRequestSchema,
  emptyCommandRequestSchema,
  meltQuoteSchema,
  mintQuoteSchema,
  pendingMeltQuotesSchema,
  pendingMintQuotesSchema,
  QUOTE_METHODS,
  type MeltQuoteDocument,
  type MintQuoteDocument,
  type PageDocument,
} from '../resource-schemas.js';
import type { RuntimeSchema } from '../schema-nodes.js';
import { withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  fromMillis,
  fromSeconds,
  normalizeRequestMintUrl,
  notFound,
  pageParameters,
  paginate,
  pathIdentifier,
  queryEnum,
  queryMintUrl,
  requireRunningSession,
  type ResourceRoute,
} from './shared.js';

function toMintQuoteDocument(quote: MintQuote): MintQuoteDocument {
  return {
    type: 'mint',
    mintUrl: quote.mintUrl,
    quoteId: quote.quoteId,
    method: quote.method,
    request: quote.request,
    unit: quote.unit,
    ...(quote.amount !== undefined ? { amount: quote.amount.toString() } : {}),
    amountPaid: quote.amountPaid.toString(),
    amountIssued: quote.amountIssued.toString(),
    reusable: quote.reusable,
    ...(quote.method === 'bolt11' ? { state: quote.state } : {}),
    expiry: quote.expiry === null ? null : fromSeconds(quote.expiry),
    createdAt: fromMillis(quote.createdAt),
    updatedAt: fromMillis(quote.updatedAt),
  };
}

function toMeltQuoteDocument(quote: MeltQuote): MeltQuoteDocument {
  return {
    type: 'melt',
    mintUrl: quote.mintUrl,
    quoteId: quote.quoteId,
    method: quote.method,
    request: quote.request,
    unit: quote.unit,
    amount: quote.amount.toString(),
    state: quote.state,
    ...(quote.method === 'onchain'
      ? {
          feeOptions: quote.fee_options.map((option) => ({
            feeIndex: option.fee_index,
            feeReserve: option.fee_reserve.toString(),
            estimatedBlocks: option.estimated_blocks,
          })),
        }
      : { feeReserve: quote.fee_reserve.toString() }),
    expiry: fromSeconds(quote.expiry),
    createdAt: fromMillis(quote.createdAt),
    updatedAt: fromMillis(quote.updatedAt),
  };
}

interface QuoteResource<TQuote extends MintQuote | MeltQuote, TDocument> {
  type: 'mint' | 'melt';
  label: 'Mint Quote' | 'Melt Quote';
  api(manager: Manager): {
    get(identity: { mintUrl: string; quoteId: string }): Promise<TQuote | null>;
    listPending(input: { method?: (typeof QUOTE_METHODS)[number] }): Promise<TQuote[]>;
    refresh(identity: { mintUrl: string; quoteId: string }): Promise<TQuote>;
  };
  toDocument(quote: TQuote): TDocument;
}

/** Collection, lookup, and refresh routes shared by both Quote namespaces. */
function quoteReadRoutes<TQuote extends MintQuote | MeltQuote, TDocument>(
  resource: QuoteResource<TQuote, TDocument>,
  schemas: { document: RuntimeSchema<TDocument>; page: RuntimeSchema<PageDocument<TDocument>> },
): ResourceRoute[] {
  const identityParameters = {
    quoteId: pathIdentifier(`${resource.label} ID assigned by the Mint.`),
    mintUrl: queryMintUrl(`Mint that issued the ${resource.label}.`),
  };
  const requireQuote = async (manager: Manager, identity: { mintUrl: string; quoteId: string }) => {
    const quote = await withCocoErrors({ action: `read the ${resource.label}` }, () =>
      resource.api(manager).get(identity),
    );
    if (!quote) throw notFound(`The ${resource.label} does not exist`, { ...identity });
    return quote;
  };
  return [
    defineResourceRoute({
      method: 'GET',
      path: `/v1/quotes/${resource.type}/pending`,
      capability: 'wallet:read',
      summary: `List pending ${resource.label}s`,
      requestSchema: noBodySchema,
      responseSchema: schemas.page,
      parameters: {
        method: queryEnum(QUOTE_METHODS, 'Restrict the collection to one payment method.'),
        ...pageParameters,
      },
      handler: async (_input, { params }, { runtime }) => {
        const { manager } = requireRunningSession(runtime);
        const quotes = await withCocoErrors({ action: `list pending ${resource.label}s` }, () =>
          resource.api(manager).listPending(params.method ? { method: params.method } : {}),
        );
        return paginate(
          quotes,
          (quote) => ({ createdAt: quote.createdAt, id: `${quote.mintUrl} ${quote.quoteId}` }),
          resource.toDocument,
          params,
        );
      },
    }),
    defineResourceRoute({
      method: 'GET',
      path: `/v1/quotes/${resource.type}/{quoteId}`,
      capability: 'wallet:read',
      summary: `Read a ${resource.label}`,
      requestSchema: noBodySchema,
      responseSchema: schemas.document,
      parameters: identityParameters,
      handler: async (_input, { params }, { runtime }) => {
        const { manager } = requireRunningSession(runtime);
        return resource.toDocument(await requireQuote(manager, params));
      },
    }),
    defineResourceRoute({
      method: 'POST',
      path: `/v1/quotes/${resource.type}/{quoteId}/refresh`,
      capability: 'wallet:admin',
      summary: `Reconcile a ${resource.label} with the Mint`,
      requestSchema: emptyCommandRequestSchema,
      responseSchema: schemas.document,
      idempotencyKey: 'optional',
      parameters: identityParameters,
      handler: async (_input, { params }, { runtime }) => {
        const { manager } = requireRunningSession(runtime);
        await requireQuote(manager, params);
        const quote = await withCocoErrors({ action: `refresh the ${resource.label}` }, () =>
          resource.api(manager).refresh(params),
        );
        return resource.toDocument(quote);
      },
    }),
  ];
}

export const quoteRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/quotes/mint',
    capability: 'wallet:admin',
    summary: 'Create a Mint Quote',
    requestSchema: createMintQuoteRequestSchema,
    responseSchema: mintQuoteSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined ? session.mintUrl : normalizeRequestMintUrl(input.mintUrl);
      const quote = await withCocoErrors({ action: 'create the Mint Quote' }, () => {
        switch (input.method) {
          case 'bolt11':
            return session.manager.quotes.mint.create({
              mintUrl,
              method: 'bolt11',
              amount: input.amount,
              ...(input.unit !== undefined ? { unit: input.unit } : {}),
              ...(input.locked === true ? { locked: true } : {}),
            });
          case 'bolt12':
            return session.manager.quotes.mint.create({
              mintUrl,
              method: 'bolt12',
              ...(input.amount !== undefined ? { amount: input.amount } : {}),
              ...(input.unit !== undefined ? { unit: input.unit } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
            });
          case 'onchain':
            return session.manager.quotes.mint.create({
              mintUrl,
              method: 'onchain',
              ...(input.unit !== undefined ? { unit: input.unit } : {}),
            });
        }
      });
      return new V1HttpResponse(toMintQuoteDocument(quote), 201);
    },
  }),
  ...quoteReadRoutes(
    {
      type: 'mint',
      label: 'Mint Quote',
      api: (manager) => manager.quotes.mint,
      toDocument: toMintQuoteDocument,
    },
    { document: mintQuoteSchema, page: pendingMintQuotesSchema },
  ),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/quotes/melt',
    capability: 'wallet:admin',
    summary: 'Create a Melt Quote',
    requestSchema: createMeltQuoteRequestSchema,
    responseSchema: meltQuoteSchema,
    successStatuses: [201],
    idempotencyKey: 'optional',
    handler: async (input, _context, { runtime }) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined ? session.mintUrl : normalizeRequestMintUrl(input.mintUrl);
      const unit = input.unit !== undefined ? { unit: input.unit } : {};
      const quote = await withCocoErrors(
        { action: 'create the Melt Quote' },
        (): Promise<MeltQuote> => {
          const melt = session.manager.quotes.melt;
          switch (input.method) {
            case 'bolt11':
              return melt.create({
                mintUrl,
                method: 'bolt11',
                methodData: {
                  invoice: input.invoice,
                  ...(input.amountSats !== undefined ? { amountSats: input.amountSats } : {}),
                },
                ...unit,
              });
            case 'bolt12':
              return melt.create({
                mintUrl,
                method: 'bolt12',
                methodData: {
                  offer: input.offer,
                  ...(input.amountSats !== undefined ? { amountSats: input.amountSats } : {}),
                },
                ...unit,
              });
            case 'onchain':
              return melt.create({
                mintUrl,
                method: 'onchain',
                methodData: { address: input.address, amountSats: input.amountSats },
                ...unit,
              });
          }
        },
      );
      return new V1HttpResponse(toMeltQuoteDocument(quote), 201);
    },
  }),
  ...quoteReadRoutes(
    {
      type: 'melt',
      label: 'Melt Quote',
      api: (manager) => manager.quotes.melt,
      toDocument: toMeltQuoteDocument,
    },
    { document: meltQuoteSchema, page: pendingMeltQuotesSchema },
  ),
];
