import {
  amountNode,
  arrayNode,
  booleanNode,
  enumNode,
  integerNode,
  literalNode,
  namedSchema,
  nullableNode,
  objectNode,
  positiveAmountNode,
  stringNode,
  unionNode,
  type SchemaNode,
} from '../schema-nodes.js';

import { assertHttpMintUrl, type PageDocument } from '../resource-schemas.js';

/** Composite Coco identity of a Mint or Melt Quote. */
export interface QuoteReferenceDocument {
  mintUrl: string;
  quoteId: string;
}

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

/** Request-side Mint URL: an absolute HTTP(S) URL that Coco normalizes. */
const mintUrlRequestNode: SchemaNode = {
  jsonSchema: mintUrlNode.jsonSchema,
  parse(value, path) {
    mintUrlNode.parse(value, path);
    assertHttpMintUrl(value as string, path);
    return value;
  },
};

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
