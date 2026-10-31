import type { LifecycleOperationType } from '@cashu/coco-core';

import {
  amountNode,
  arrayNode,
  booleanNode,
  enumNode,
  integerNode,
  jsonValueNode,
  literalNode,
  namedSchema,
  nullableNode,
  objectNode,
  positiveAmountNode,
  stringNode,
  unionNode,
  type SchemaNode,
} from './schema-nodes.js';

// ---------------------------------------------------------------------------
// Shared representation
// ---------------------------------------------------------------------------

/** A page of a collection selected with `offset` and `limit`. */
export interface PageDocument<T> {
  items: T[];
  offset: number;
  limit: number;
}

/** Composite Coco identity of a Mint or Melt Quote. */
export interface QuoteReferenceDocument {
  mintUrl: string;
  quoteId: string;
}

/** Commands without inputs accept no body or an empty JSON object. */
export type EmptyCommandRequest = null | Record<string, never>;

const timestampNode = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const identifierNode = stringNode({ minLength: 1, maxLength: 512 });
const unitNode = stringNode({ minLength: 1, maxLength: 32 });
const mintUrlNode = stringNode({ format: 'uri', pattern: '^https?://', maxLength: 2048 });
const quoteReferenceNode = objectNode({ mintUrl: mintUrlNode, quoteId: identifierNode });

function pageNode(item: SchemaNode): SchemaNode {
  return objectNode({
    items: arrayNode(item),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  });
}

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

/** Request-side Mint URL: an absolute HTTP(S) URL that Coco normalizes. */
const mintUrlRequestNode: SchemaNode = {
  jsonSchema: mintUrlNode.jsonSchema,
  parse(value, path) {
    mintUrlNode.parse(value, path);
    assertHttpMintUrl(value as string, path);
    return value;
  },
};

export const emptyCommandRequestSchema = namedSchema<EmptyCommandRequest>(
  'EmptyCommandRequest',
  unionNode([literalNode(null), objectNode({})], 'anyOf'),
);

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** Spendable, reserved, and total balance of one Mint and unit. */
export interface BalanceDocument {
  mintUrl: string;
  unit: string;
  spendable: string;
  reserved: string;
  total: string;
}

export interface BalancesDocument {
  items: BalanceDocument[];
}

export const balancesSchema = namedSchema<BalancesDocument>(
  'Balances',
  objectNode({
    items: arrayNode(
      objectNode({
        mintUrl: mintUrlNode,
        unit: unitNode,
        spendable: amountNode(),
        reserved: amountNode(),
        total: amountNode(),
      }),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Known Mints
// ---------------------------------------------------------------------------

/** Safe projection of a Known Mint. */
export interface KnownMintDocument {
  mintUrl: string;
  name: string;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnownMintsDocument {
  items: KnownMintDocument[];
}

export interface RegisterMintRequest {
  mintUrl: string;
  trusted?: boolean;
}

export interface MintTrustRequest {
  mintUrl: string;
}

/** Mint information as advertised by the Mint (NUT-06). */
export interface MintInformationDocument {
  mintUrl: string;
  info: Record<string, unknown>;
}

/** One enabled NUT-04 or NUT-05 method and unit advertised by a Known Mint. */
export interface PaymentMethodCapabilityDocument {
  operation: 'mint' | 'melt';
  nut: 4 | 5;
  method: string;
  unit: string;
  minAmount?: string | null;
  maxAmount?: string | null;
  options?: unknown;
}

export interface PaymentMethodCapabilitiesDocument {
  mintUrl: string;
  items: PaymentMethodCapabilityDocument[];
}

const knownMintNode = objectNode({
  mintUrl: mintUrlNode,
  name: stringNode(),
  trusted: booleanNode(),
  createdAt: timestampNode,
  updatedAt: timestampNode,
});

export const knownMintSchema = namedSchema<KnownMintDocument>('KnownMint', knownMintNode);

export const knownMintsSchema = namedSchema<KnownMintsDocument>(
  'KnownMints',
  objectNode({ items: arrayNode(knownMintNode) }),
);

export const registerMintRequestSchema = namedSchema<RegisterMintRequest>(
  'RegisterMintRequest',
  objectNode({ mintUrl: mintUrlRequestNode, trusted: booleanNode() }, { optional: ['trusted'] }),
);

export const mintTrustRequestSchema = namedSchema<MintTrustRequest>(
  'MintTrustRequest',
  objectNode({ mintUrl: mintUrlRequestNode }),
);

export const mintInformationSchema = namedSchema<MintInformationDocument>(
  'MintInformation',
  objectNode({ mintUrl: mintUrlNode, info: objectNode({}, { additionalProperties: true }) }),
);

export const paymentMethodCapabilitiesSchema = namedSchema<PaymentMethodCapabilitiesDocument>(
  'PaymentMethodCapabilities',
  objectNode({
    mintUrl: mintUrlNode,
    items: arrayNode(
      objectNode(
        {
          operation: enumNode(['mint', 'melt']),
          nut: unionNode([
            { jsonSchema: { const: 4 }, parse: (value, path) => constant(value, 4, path) },
            { jsonSchema: { const: 5 }, parse: (value, path) => constant(value, 5, path) },
          ]),
          method: stringNode(),
          unit: unitNode,
          minAmount: nullableNode(amountNode()),
          maxAmount: nullableNode(amountNode()),
          options: jsonValueNode(),
        },
        { optional: ['minAmount', 'maxAmount', 'options'] },
      ),
    ),
  }),
);

function constant<T extends number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} must equal ${expected}`);
  return expected;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

export const QUOTE_METHODS = ['bolt11', 'bolt12', 'onchain'] as const;

export type QuoteMethod = (typeof QUOTE_METHODS)[number];

export type CreateMintQuoteRequest =
  | { method: 'bolt11'; amount: string; unit?: string; mintUrl?: string; locked?: boolean }
  | { method: 'bolt12'; amount?: string; unit?: string; mintUrl?: string; description?: string }
  | { method: 'onchain'; unit?: string; mintUrl?: string };

/** Safe projection of a Mint Quote; `state` is reported only by stateful (BOLT11) quotes. */
export interface MintQuoteDocument {
  type: 'mint';
  mintUrl: string;
  quoteId: string;
  method: QuoteMethod;
  request: string;
  unit: string;
  amount?: string;
  amountPaid: string;
  amountIssued: string;
  reusable: boolean;
  state?: 'UNPAID' | 'PAID' | 'ISSUED';
  expiry: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CreateMeltQuoteRequest =
  | { method: 'bolt11'; invoice: string; amountSats?: string; unit?: string; mintUrl?: string }
  | { method: 'bolt12'; offer: string; amountSats?: string; unit?: string; mintUrl?: string }
  | { method: 'onchain'; address: string; amountSats: string; unit?: string; mintUrl?: string };

export interface MeltFeeOptionDocument {
  feeIndex: number;
  feeReserve: string;
  estimatedBlocks: number;
}

/** Safe projection of a Melt Quote; BOLT quotes carry `feeReserve`, on-chain quotes `feeOptions`. */
export interface MeltQuoteDocument {
  type: 'melt';
  mintUrl: string;
  quoteId: string;
  method: QuoteMethod;
  request: string;
  unit: string;
  amount: string;
  state: 'UNPAID' | 'PENDING' | 'PAID';
  feeReserve?: string;
  feeOptions?: MeltFeeOptionDocument[];
  expiry: string;
  createdAt: string;
  updatedAt: string;
}

const quoteMethodNode = enumNode(QUOTE_METHODS);
const meltPaymentAmountNode = positiveAmountNode(
  'Payment amount in satoshis, independent of the ecash unit that funds the payment.',
);
const fundingUnitNode = stringNode({
  minLength: 1,
  maxLength: 32,
  description: 'Ecash unit that funds the payment and denominates the Quote amounts (default sat).',
});

export const createMintQuoteRequestSchema = namedSchema<CreateMintQuoteRequest>(
  'CreateMintQuoteRequest',
  unionNode([
    objectNode(
      {
        method: literalNode('bolt11'),
        amount: positiveAmountNode(),
        unit: unitNode,
        mintUrl: mintUrlRequestNode,
        locked: booleanNode(),
      },
      { optional: ['unit', 'mintUrl', 'locked'] },
    ),
    objectNode(
      {
        method: literalNode('bolt12'),
        amount: positiveAmountNode(),
        unit: unitNode,
        mintUrl: mintUrlRequestNode,
        description: stringNode({ maxLength: 1024 }),
      },
      { optional: ['amount', 'unit', 'mintUrl', 'description'] },
    ),
    objectNode(
      { method: literalNode('onchain'), unit: unitNode, mintUrl: mintUrlRequestNode },
      { optional: ['unit', 'mintUrl'] },
    ),
  ]),
);

const mintQuoteNode = objectNode(
  {
    type: literalNode('mint'),
    mintUrl: mintUrlNode,
    quoteId: identifierNode,
    method: quoteMethodNode,
    request: stringNode(),
    unit: unitNode,
    amount: amountNode(),
    amountPaid: amountNode(),
    amountIssued: amountNode(),
    reusable: booleanNode(),
    state: enumNode(['UNPAID', 'PAID', 'ISSUED']),
    expiry: nullableNode(timestampNode),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['amount', 'state'] },
);

export const mintQuoteSchema = namedSchema<MintQuoteDocument>('MintQuote', mintQuoteNode);

export const pendingMintQuotesSchema = namedSchema<PageDocument<MintQuoteDocument>>(
  'PendingMintQuotes',
  pageNode(mintQuoteNode),
);

export const createMeltQuoteRequestSchema = namedSchema<CreateMeltQuoteRequest>(
  'CreateMeltQuoteRequest',
  unionNode([
    objectNode(
      {
        method: literalNode('bolt11'),
        invoice: stringNode({ minLength: 1, sensitive: true }),
        amountSats: meltPaymentAmountNode,
        unit: fundingUnitNode,
        mintUrl: mintUrlRequestNode,
      },
      { optional: ['amountSats', 'unit', 'mintUrl'] },
    ),
    objectNode(
      {
        method: literalNode('bolt12'),
        offer: stringNode({ minLength: 1, sensitive: true }),
        amountSats: meltPaymentAmountNode,
        unit: fundingUnitNode,
        mintUrl: mintUrlRequestNode,
      },
      { optional: ['amountSats', 'unit', 'mintUrl'] },
    ),
    objectNode(
      {
        method: literalNode('onchain'),
        address: stringNode({ minLength: 1, sensitive: true }),
        amountSats: meltPaymentAmountNode,
        unit: fundingUnitNode,
        mintUrl: mintUrlRequestNode,
      },
      { optional: ['unit', 'mintUrl'] },
    ),
  ]),
);

const meltQuoteNode = objectNode(
  {
    type: literalNode('melt'),
    mintUrl: mintUrlNode,
    quoteId: identifierNode,
    method: quoteMethodNode,
    request: stringNode(),
    unit: unitNode,
    amount: amountNode(),
    state: enumNode(['UNPAID', 'PENDING', 'PAID']),
    feeReserve: amountNode(),
    feeOptions: arrayNode(
      objectNode({
        feeIndex: integerNode({ minimum: 0 }),
        feeReserve: amountNode(),
        estimatedBlocks: integerNode({ minimum: 0 }),
      }),
    ),
    expiry: timestampNode,
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['feeReserve', 'feeOptions'] },
);

export const meltQuoteSchema = namedSchema<MeltQuoteDocument>('MeltQuote', meltQuoteNode);

export const pendingMeltQuotesSchema = namedSchema<PageDocument<MeltQuoteDocument>>(
  'PendingMeltQuotes',
  pageNode(meltQuoteNode),
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface PrepareMintOperationRequest {
  mintUrl: string;
  quoteId: string;
  amount: string;
}

/** Safe projection of a Mint Operation; failures omit the Mint's diagnostic text. */
export interface MintOperationDocument {
  id: string;
  type: 'mint';
  state: 'init' | 'pending' | 'executing' | 'finalized' | 'failed';
  mintUrl: string;
  method: QuoteMethod;
  unit: string;
  amount: string;
  quote: QuoteReferenceDocument;
  expiry?: string | null;
  failure?: { code?: string; retryable?: boolean; observedAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface PrepareMeltOperationRequest {
  mintUrl: string;
  quoteId: string;
  feeIndex?: number;
}

/** Safe projection of a Melt Operation; amounts appear once the Operation is prepared. */
export interface MeltOperationDocument {
  id: string;
  type: 'melt';
  state:
    | 'init'
    | 'prepared'
    | 'executing'
    | 'pending'
    | 'failed'
    | 'finalized'
    | 'rolling_back'
    | 'rolled_back';
  mintUrl: string;
  method: QuoteMethod;
  unit: string;
  quote?: QuoteReferenceDocument;
  amount?: string;
  feeReserve?: string;
  swapFee?: string;
  inputAmount?: string;
  needsSwap?: boolean;
  feeIndex?: number;
  changeAmount?: string;
  effectiveFee?: string;
  createdAt: string;
  updatedAt: string;
}

/** Proof of payment of a finalized Melt Operation. */
export type MeltResultDocument = { preimage: string } | { outpoint: string };

export interface ExecuteMeltOperationResponse {
  operation: MeltOperationDocument;
  result?: MeltResultDocument;
}

export type PrepareSendOperationRequest =
  | { amount: string; unit?: string; mintUrl?: string; forceSwap?: boolean }
  | {
      source: { type: 'payment-request'; request: string };
      mintUrl?: string;
      amount?: string;
      unit?: string;
    };

/** Safe projection of a Send Operation; it never contains proofs or the token. */
export interface SendOperationDocument {
  id: string;
  type: 'send';
  state:
    | 'init'
    | 'prepared'
    | 'executing'
    | 'pending'
    | 'finalized'
    | 'rolling_back'
    | 'rolled_back';
  mintUrl: string;
  method: 'default' | 'p2pk';
  unit: string;
  amount: string;
  inputAmount?: string;
  fee?: string;
  needsSwap?: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Encoded Cashu token produced by a Send Operation; it is bearer value. */
export interface SendResultDocument {
  token: string;
}

export interface ExecuteSendOperationResponse {
  operation: SendOperationDocument;
  result: SendResultDocument;
}

export interface PrepareReceiveOperationRequest {
  token: string;
}

/** Safe projection of a Receive Operation; it never contains the received proofs. */
export interface ReceiveOperationDocument {
  id: string;
  type: 'receive';
  state: 'init' | 'prepared' | 'executing' | 'finalized' | 'rolled_back';
  mintUrl: string;
  unit: string;
  amount: string;
  fee?: string;
  createdAt: string;
  updatedAt: string;
}

export const prepareMintOperationRequestSchema = namedSchema<PrepareMintOperationRequest>(
  'PrepareMintOperationRequest',
  objectNode({
    mintUrl: mintUrlRequestNode,
    quoteId: identifierNode,
    amount: positiveAmountNode(),
  }),
);

const mintOperationNode = objectNode(
  {
    id: identifierNode,
    type: literalNode('mint'),
    state: enumNode(['init', 'pending', 'executing', 'finalized', 'failed']),
    mintUrl: mintUrlNode,
    method: quoteMethodNode,
    unit: unitNode,
    amount: amountNode(),
    quote: quoteReferenceNode,
    expiry: nullableNode(timestampNode),
    failure: objectNode(
      { code: stringNode(), retryable: booleanNode(), observedAt: timestampNode },
      { optional: ['code', 'retryable'] },
    ),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['expiry', 'failure'] },
);

export const mintOperationSchema = namedSchema<MintOperationDocument>(
  'MintOperation',
  mintOperationNode,
);

export const mintOperationsSchema = namedSchema<PageDocument<MintOperationDocument>>(
  'MintOperations',
  pageNode(mintOperationNode),
);

export const prepareMeltOperationRequestSchema = namedSchema<PrepareMeltOperationRequest>(
  'PrepareMeltOperationRequest',
  objectNode(
    {
      mintUrl: mintUrlRequestNode,
      quoteId: identifierNode,
      feeIndex: integerNode({ minimum: 0 }),
    },
    { optional: ['feeIndex'] },
  ),
);

const meltOperationNode = objectNode(
  {
    id: identifierNode,
    type: literalNode('melt'),
    state: enumNode([
      'init',
      'prepared',
      'executing',
      'pending',
      'failed',
      'finalized',
      'rolling_back',
      'rolled_back',
    ]),
    mintUrl: mintUrlNode,
    method: quoteMethodNode,
    unit: unitNode,
    quote: quoteReferenceNode,
    amount: amountNode(),
    feeReserve: amountNode(),
    swapFee: amountNode(),
    inputAmount: amountNode(),
    needsSwap: booleanNode(),
    feeIndex: integerNode({ minimum: 0 }),
    changeAmount: amountNode(),
    effectiveFee: amountNode(),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  {
    optional: [
      'quote',
      'amount',
      'feeReserve',
      'swapFee',
      'inputAmount',
      'needsSwap',
      'feeIndex',
      'changeAmount',
      'effectiveFee',
    ],
  },
);

export const meltOperationSchema = namedSchema<MeltOperationDocument>(
  'MeltOperation',
  meltOperationNode,
);

export const meltOperationsSchema = namedSchema<PageDocument<MeltOperationDocument>>(
  'MeltOperations',
  pageNode(meltOperationNode),
);

const meltResultNode = unionNode([
  objectNode({ preimage: stringNode({ minLength: 1, sensitive: true }) }),
  objectNode({ outpoint: stringNode({ minLength: 1 }) }),
]);

export const meltResultSchema = namedSchema<MeltResultDocument>('MeltResult', meltResultNode);

export const executeMeltOperationResponseSchema = namedSchema<ExecuteMeltOperationResponse>(
  'ExecuteMeltOperationResponse',
  objectNode({ operation: meltOperationNode, result: meltResultNode }, { optional: ['result'] }),
);

export const prepareSendOperationRequestSchema = namedSchema<PrepareSendOperationRequest>(
  'PrepareSendOperationRequest',
  unionNode([
    objectNode(
      {
        amount: positiveAmountNode(),
        unit: unitNode,
        mintUrl: mintUrlRequestNode,
        forceSwap: booleanNode(),
      },
      { optional: ['unit', 'mintUrl', 'forceSwap'] },
    ),
    objectNode(
      {
        source: objectNode({
          type: literalNode('payment-request'),
          request: stringNode({ minLength: 1, sensitive: true }),
        }),
        mintUrl: mintUrlRequestNode,
        amount: positiveAmountNode(),
        unit: unitNode,
      },
      { optional: ['mintUrl', 'amount', 'unit'], dependentRequired: { unit: ['amount'] } },
    ),
  ]),
);

const sendOperationNode = objectNode(
  {
    id: identifierNode,
    type: literalNode('send'),
    state: enumNode([
      'init',
      'prepared',
      'executing',
      'pending',
      'finalized',
      'rolling_back',
      'rolled_back',
    ]),
    mintUrl: mintUrlNode,
    method: enumNode(['default', 'p2pk']),
    unit: unitNode,
    amount: amountNode(),
    inputAmount: amountNode(),
    fee: amountNode(),
    needsSwap: booleanNode(),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['inputAmount', 'fee', 'needsSwap'] },
);

export const sendOperationSchema = namedSchema<SendOperationDocument>(
  'SendOperation',
  sendOperationNode,
);

export const sendOperationsSchema = namedSchema<PageDocument<SendOperationDocument>>(
  'SendOperations',
  pageNode(sendOperationNode),
);

const sendResultNode = objectNode({ token: stringNode({ minLength: 1, sensitive: true }) });

export const sendResultSchema = namedSchema<SendResultDocument>('SendResult', sendResultNode);

export const executeSendOperationResponseSchema = namedSchema<ExecuteSendOperationResponse>(
  'ExecuteSendOperationResponse',
  objectNode({ operation: sendOperationNode, result: sendResultNode }),
);

export const prepareReceiveOperationRequestSchema = namedSchema<PrepareReceiveOperationRequest>(
  'PrepareReceiveOperationRequest',
  objectNode({ token: stringNode({ minLength: 1, sensitive: true }) }),
);

const receiveOperationNode = objectNode(
  {
    id: identifierNode,
    type: literalNode('receive'),
    state: enumNode(['init', 'prepared', 'executing', 'finalized', 'rolled_back']),
    mintUrl: mintUrlNode,
    unit: unitNode,
    amount: amountNode(),
    fee: amountNode(),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['fee'] },
);

export const receiveOperationSchema = namedSchema<ReceiveOperationDocument>(
  'ReceiveOperation',
  receiveOperationNode,
);

export const receiveOperationsSchema = namedSchema<PageDocument<ReceiveOperationDocument>>(
  'ReceiveOperations',
  pageNode(receiveOperationNode),
);

// ---------------------------------------------------------------------------
// Payment Requests
// ---------------------------------------------------------------------------

export interface EvaluatePaymentRequestRequest {
  request: string;
}

/** What paying an outgoing Payment Request would require of this Wallet. */
export interface PaymentRequestEvaluationDocument {
  amount?: string;
  unit: string;
  transport: { type: 'inband' | 'http' | 'nostr' };
  allowedMints: string[];
  payableMints: string[];
  spendingCondition?: { kind: 'P2PK' } | { kind: 'unsupported' | 'malformed'; nut10Kind: string };
}

export const evaluatePaymentRequestRequestSchema = namedSchema<EvaluatePaymentRequestRequest>(
  'EvaluatePaymentRequestRequest',
  objectNode({ request: stringNode({ minLength: 1, sensitive: true }) }),
);

export const paymentRequestEvaluationSchema = namedSchema<PaymentRequestEvaluationDocument>(
  'PaymentRequestEvaluation',
  objectNode(
    {
      amount: amountNode(),
      unit: unitNode,
      transport: objectNode({ type: enumNode(['inband', 'http', 'nostr']) }),
      allowedMints: arrayNode(stringNode()),
      payableMints: arrayNode(mintUrlNode),
      spendingCondition: unionNode([
        objectNode({ kind: literalNode('P2PK') }),
        objectNode({ kind: enumNode(['unsupported', 'malformed']), nut10Kind: stringNode() }),
      ]),
    },
    { optional: ['amount', 'spendingCondition'] },
  ),
);

// ---------------------------------------------------------------------------
// History and events
// ---------------------------------------------------------------------------

/** Safe projection of a Wallet history entry; it omits tokens, requests, and metadata. */
export interface HistoryDocument {
  id: string;
  type: LifecycleOperationType;
  source: 'operation' | 'legacy';
  operationId?: string;
  quoteId?: string;
  state: string;
  mintUrl: string;
  unit: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

const historyNode = objectNode(
  {
    id: identifierNode,
    type: enumNode(['mint', 'melt', 'send', 'receive']),
    source: enumNode(['operation', 'legacy']),
    operationId: identifierNode,
    quoteId: identifierNode,
    state: stringNode(),
    mintUrl: stringNode(),
    unit: unitNode,
    amount: amountNode(),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['operationId', 'quoteId'] },
);

export const historySchema = namedSchema<HistoryDocument>('History', historyNode);

export const historyPageSchema = namedSchema<PageDocument<HistoryDocument>>(
  'HistoryPage',
  pageNode(historyNode),
);

/** Invalidation published on the event stream; clients refetch the named resource. */
export type ResourceEventDocument = { timestamp: string } & (
  | { type: 'history.updated'; data: HistoryDocument }
  | {
      type: 'operation.updated';
      data: {
        operationType: LifecycleOperationType;
        operationId: string;
        mintUrl: string;
      };
    }
  | {
      type: 'quote.updated';
      data: { quoteType: 'mint' | 'melt'; mintUrl: string; method: string; quoteId: string };
    }
  | { type: 'mint.updated'; data: { mintUrl: string } }
  | { type: 'balance.updated'; data: { mintUrl: string } }
);

export const resourceEventSchema = namedSchema<ResourceEventDocument>(
  'ResourceEvent',
  unionNode([
    objectNode({
      type: literalNode('history.updated'),
      timestamp: timestampNode,
      data: historyNode,
    }),
    objectNode({
      type: literalNode('operation.updated'),
      timestamp: timestampNode,
      data: objectNode({
        operationType: enumNode(['mint', 'melt', 'send', 'receive']),
        operationId: identifierNode,
        mintUrl: mintUrlNode,
      }),
    }),
    objectNode({
      type: literalNode('quote.updated'),
      timestamp: timestampNode,
      data: objectNode({
        quoteType: enumNode(['mint', 'melt']),
        mintUrl: mintUrlNode,
        method: stringNode(),
        quoteId: identifierNode,
      }),
    }),
    objectNode({
      type: literalNode('mint.updated'),
      timestamp: timestampNode,
      data: objectNode({ mintUrl: mintUrlNode }),
    }),
    objectNode({
      type: literalNode('balance.updated'),
      timestamp: timestampNode,
      data: objectNode({ mintUrl: mintUrlNode }),
    }),
  ]),
);

// ---------------------------------------------------------------------------
// Interface description
// ---------------------------------------------------------------------------

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
