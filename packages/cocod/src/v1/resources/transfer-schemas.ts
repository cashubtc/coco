import { assertHttpMintUrl, type PageDocument } from '../resource-schemas.js';
import {
  amountNode,
  arrayNode,
  booleanNode,
  enumNode,
  integerNode,
  literalNode,
  namedSchema,
  objectNode,
  positiveAmountNode,
  stringNode,
  unionNode,
  type SchemaNode,
} from '../schema-nodes.js';

const timestampNode = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const identifierNode = stringNode({ minLength: 1, maxLength: 512 });
const unitNode = stringNode({ minLength: 1, maxLength: 32 });
const mintUrlNode = stringNode({ format: 'uri', pattern: '^https?://', maxLength: 2048 });
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
