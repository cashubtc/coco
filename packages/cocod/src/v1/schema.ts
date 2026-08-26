import type { CocodStatus } from '../runtime.js';
import { V1HttpError } from './contract.js';

/** Runtime validator paired with the JSON Schema emitted for the same document. */
export interface RuntimeSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

/** Extracts the parsed document type from a runtime schema. */
export type InferSchema<Schema extends RuntimeSchema<unknown>> =
  Schema extends RuntimeSchema<infer Output> ? Output : never;

/** Stable error codes that v1 clients may branch on. */
export const V1_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'invalid_request',
  'not_found',
  'method_not_allowed',
  'unsupported_behavior',
  'invalid_operation_state',
  'operation_in_progress',
  'operation_result_not_available',
  'internal_error',
  'invalid_idempotency_key',
  'idempotency_key_conflict',
  'idempotency_capacity_exceeded',
  'wallet_already_configured',
  'wallet_not_configured',
  'passphrase_required',
  'wallet_unlock_failed',
  'session_transition_in_progress',
  'session_restart_required',
  'wallet_locked',
  'session_stopped',
  'coco_error',
  'process_shutting_down',
] as const;

/** Stable machine-readable code carried by every v1 error document. */
export type V1ErrorCode = (typeof V1_ERROR_CODES)[number];

const INTERFACE_VERSION = '1' as const;

interface SchemaNode<T> {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown, path: string): T;
}

type InferNode<Node extends SchemaNode<unknown>> =
  Node extends SchemaNode<infer Output> ? Output : never;

type SchemaProperties = Readonly<Record<string, SchemaNode<unknown>>>;

// Derive required and optional fields from the same list used by parsing and JSON Schema.
type InferObject<
  Properties extends SchemaProperties,
  Optional extends keyof Properties,
  AdditionalProperties extends boolean,
> = keyof Properties extends never
  ? AdditionalProperties extends true
    ? Record<string, unknown>
    : Record<string, never>
  : {
      -readonly [Key in keyof Properties as Key extends Optional ? never : Key]: InferNode<
        Properties[Key]
      >;
    } & {
      -readonly [Key in Optional]?: InferNode<Properties[Key]>;
    } & (AdditionalProperties extends true ? Record<string, unknown> : unknown);

type UnionKeys<Union> = Union extends Union ? keyof Union : never;

// Reflect additionalProperties: false for fields that exist only on other union branches.
type StrictUnion<Union, All = Union> = Union extends object
  ? Union & Partial<Record<Exclude<UnionKeys<All>, keyof Union>, never>>
  : Union;

const rfc3339UtcSchema = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const daemonStatusNode = objectNode({
  version: stringNode(),
  interfaceVersion: literalNode(INTERFACE_VERSION),
});
const walletStatusNode = objectNode({ configuredAt: rfc3339UtcSchema });
const seedAccessStatusNode = objectNode({
  state: enumNode(['locked', 'available']),
  requiresPassphrase: booleanNode(),
});
const lastFailureNode = nullableNode(
  objectNode({
    code: stringNode(),
    message: stringNode(),
    occurredAt: rfc3339UtcSchema,
  }),
);
const cocoSessionStatusNode = objectNode({
  state: enumNode(['stopped', 'starting', 'running', 'stopping', 'failed']),
  startedAt: nullableNode(rfc3339UtcSchema),
  lastFailure: lastFailureNode,
});
const lifecycleStatusNode = unionNode([
  objectNode({
    daemon: daemonStatusNode,
    wallet: literalNode(null),
    seedAccess: literalNode(null),
    cocoSession: cocoSessionStatusNode,
  }),
  objectNode({
    daemon: daemonStatusNode,
    wallet: walletStatusNode,
    seedAccess: seedAccessStatusNode,
    cocoSession: cocoSessionStatusNode,
  }),
]);
const sensitivePassphraseRequestNode = objectNode(
  { passphrase: stringNode({ sensitive: true }) },
  { optional: ['passphrase'] },
);

/** Runtime schema for a route that accepts no request body. */
export const noBodySchema = namedSchema('NoBody', literalNode(null));

/** Schema marker for an implemented route that has no successful response. */
export const noSuccessResponseSchema: RuntimeSchema<never> = {
  name: 'Never',
  jsonSchema: { not: {} },
  parse() {
    throw new V1HttpError({
      status: 500,
      code: 'internal_error',
      message: 'This resource does not return a successful response',
      retryable: false,
    });
  },
};

/** Runtime and generated schema for `GET /health`. */
export const healthSchema = namedSchema(
  'Health',
  objectNode({
    status: literalNode('ok'),
    interfaceVersion: literalNode(INTERFACE_VERSION),
  }),
);

/** Shallow runtime guard for the generated OpenAPI document returned by cocod. */
export const openApiDocumentSchema: RuntimeSchema<unknown> = {
  name: 'OpenApiDocument',
  jsonSchema: {
    type: 'object',
    additionalProperties: true,
    required: ['openapi', 'info', 'paths', 'components'],
    properties: {
      openapi: { const: '3.1.0' },
      info: { type: 'object' },
      paths: { type: 'object' },
      components: { type: 'object' },
    },
  },
  parse(value) {
    const document = requireRecord(value, '$');
    if (document.openapi !== '3.1.0') throw new Error('$.openapi must be 3.1.0');
    requireRecord(document.info, '$.info');
    requireRecord(document.paths, '$.paths');
    requireRecord(document.components, '$.components');
    return value;
  },
};

/** Runtime and generated schema for the common v1 error document. */
export const v1ErrorSchema = namedSchema(
  'Error',
  objectNode({
    error: objectNode(
      {
        code: enumNode(V1_ERROR_CODES),
        message: stringNode(),
        retryable: booleanNode(),
        details: objectNode({}, { additionalProperties: true }),
      },
      { optional: ['details'] },
    ),
  }),
);

/** Runtime and generated schema for authenticated lifecycle status. */
export const lifecycleStatusSchema = namedSchema('LifecycleStatus', lifecycleStatusNode);

/** Runtime and generated schema for Wallet initialization requests. */
export const initializeWalletRequestSchema = namedSchema(
  'InitializeWalletRequest',
  sensitivePassphraseRequestNode,
);

/** Runtime and generated schema for Wallet Recovery Material retrieval requests. */
export const walletRecoveryMaterialRequestSchema = namedSchema(
  'WalletRecoveryMaterialRequest',
  sensitivePassphraseRequestNode,
);

/** Runtime and generated schema for Coco Session start requests. */
export const startSessionRequestSchema = namedSchema(
  'StartSessionRequest',
  sensitivePassphraseRequestNode,
);

/** Runtime and generated schema for Coco Session stop requests. */
export const stopSessionRequestSchema = namedSchema('StopSessionRequest', objectNode({}));

/** Runtime and generated schema for Cocod Process shutdown requests. */
export const processShutdownRequestSchema = namedSchema('ProcessShutdownRequest', objectNode({}));

/** Runtime and generated schema for the sensitive Wallet initialization response. */
export const initializeWalletResponseSchema = namedSchema(
  'InitializeWalletResponse',
  objectNode({
    generatedMnemonic: stringNode({ sensitive: true }),
    status: lifecycleStatusNode,
  }),
);

/** Runtime and generated schema for sensitive Wallet Recovery Material responses. */
export const walletRecoveryMaterialResponseSchema = namedSchema(
  'WalletRecoveryMaterialResponse',
  objectNode({ mnemonic: stringNode({ sensitive: true }) }),
);

/** Runtime and generated schema for accepted Cocod Process shutdown. */
export const processShutdownResponseSchema = namedSchema(
  'ProcessShutdownResponse',
  objectNode({ status: literalNode('stopping') }),
);

const decimalAmountNode = stringNode({ pattern: '^(0|[1-9]\\d*)$' });
const positiveDecimalAmountNode = stringNode({ pattern: '^[1-9]\\d*$' });

/** Runtime and generated schema for safe Wallet balances. */
export const balancesSchema = namedSchema(
  'Balances',
  objectNode({
    items: arrayNode(
      objectNode({
        mintUrl: stringNode(),
        unit: stringNode(),
        spendable: decimalAmountNode,
        reserved: decimalAmountNode,
        total: decimalAmountNode,
      }),
    ),
  }),
);

const historyBaseFields = {
  id: stringNode({ pattern: '\\S' }),
  source: enumNode(['operation', 'legacy']),
  operationId: stringNode({ pattern: '\\S' }),
  state: stringNode({ pattern: '\\S' }),
  mintUrl: stringNode({ pattern: '\\S' }),
  unit: stringNode({ pattern: '\\S' }),
  amount: decimalAmountNode,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const historyDocumentNode = unionNode([
  objectNode(
    { ...historyBaseFields, type: literalNode('mint'), quoteId: stringNode({ pattern: '\\S' }) },
    { optional: ['operationId', 'quoteId'] },
  ),
  objectNode(
    { ...historyBaseFields, type: literalNode('melt'), quoteId: stringNode({ pattern: '\\S' }) },
    { optional: ['operationId', 'quoteId'] },
  ),
  objectNode({ ...historyBaseFields, type: literalNode('send') }, { optional: ['operationId'] }),
  objectNode({ ...historyBaseFields, type: literalNode('receive') }, { optional: ['operationId'] }),
]);

/** Runtime and generated schema for one safe Wallet history entry. */
export const historySchema = namedSchema('History', historyDocumentNode);

/** Runtime and generated schema for offset-paginated safe Wallet history. */
export const historyPageSchema = namedSchema(
  'HistoryPage',
  objectNode({
    items: arrayNode(historyDocumentNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1, maximum: 100 }),
  }),
);

const invalidationTimestamp = rfc3339UtcSchema;
const mintInvalidationDataNode = objectNode({ mintUrl: stringNode({ pattern: '\\S' }) });

/** Runtime and generated schema for one SSE resource invalidation event. */
export const resourceInvalidationEventSchema = namedSchema(
  'ResourceInvalidationEvent',
  unionNode([
    objectNode({
      type: literalNode('history.updated'),
      timestamp: invalidationTimestamp,
      data: historyDocumentNode,
    }),
    objectNode({
      type: literalNode('operation.updated'),
      timestamp: invalidationTimestamp,
      data: objectNode({
        operationType: enumNode(['mint', 'melt', 'send', 'receive']),
        operationId: stringNode({ pattern: '\\S' }),
        mintUrl: stringNode({ pattern: '\\S' }),
      }),
    }),
    objectNode({
      type: literalNode('quote.updated'),
      timestamp: invalidationTimestamp,
      data: objectNode({
        quoteType: enumNode(['mint', 'melt']),
        mintUrl: stringNode({ pattern: '\\S' }),
        method: stringNode({ pattern: '\\S' }),
        quoteId: stringNode({ pattern: '\\S' }),
      }),
    }),
    objectNode({
      type: literalNode('mint.updated'),
      timestamp: invalidationTimestamp,
      data: mintInvalidationDataNode,
    }),
    objectNode({
      type: literalNode('balance.updated'),
      timestamp: invalidationTimestamp,
      data: mintInvalidationDataNode,
    }),
  ]),
);

const knownMintNode = objectNode({
  mintUrl: stringNode(),
  name: stringNode(),
  trusted: booleanNode(),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
});

/** Runtime and generated schema for a request identifying a Mint by URL. */
export const mintUrlRequestSchema = namedSchema(
  'MintUrlRequest',
  objectNode({ mintUrl: stringNode() }),
);

/** Runtime and generated schema for one safe Known Mint resource. */
export const knownMintSchema = namedSchema('KnownMint', knownMintNode);

/** Runtime and generated schema for the Known Mint collection. */
export const knownMintsSchema = namedSchema(
  'KnownMints',
  objectNode({ items: arrayNode(knownMintNode) }),
);

/** Runtime and generated schema for refreshed Mint metadata. */
export const mintInformationSchema = namedSchema(
  'MintInformation',
  objectNode({
    mintUrl: stringNode(),
    info: objectNode({}, { additionalProperties: true }),
  }),
);

const paymentMethodCapabilityNode = objectNode(
  {
    operation: enumNode(['mint', 'melt']),
    nut: unionNode([literalNode(4), literalNode(5)]),
    method: stringNode(),
    unit: stringNode(),
    minAmount: nullableNode(decimalAmountNode),
    maxAmount: nullableNode(decimalAmountNode),
    options: anyNode(),
  },
  { optional: ['minAmount', 'maxAmount', 'options'] },
);

/** Runtime and generated schema for Mint and Melt payment-method capabilities. */
export const paymentMethodCapabilitiesSchema = namedSchema(
  'PaymentMethodCapabilities',
  objectNode({ items: arrayNode(paymentMethodCapabilityNode) }),
);

/** Runtime and generated schema for outgoing Payment Request evaluation input. */
export const evaluatePaymentRequestRequestSchema = namedSchema(
  'EvaluatePaymentRequestRequest',
  objectNode({ request: stringNode({ pattern: '\\S', sensitive: true }) }),
);

const paymentRequestSpendingConditionNode = unionNode([
  objectNode({ kind: literalNode('P2PK') }),
  objectNode({ kind: literalNode('unsupported'), nut10Kind: stringNode() }),
  objectNode({ kind: literalNode('malformed'), nut10Kind: stringNode() }),
]);

/** Runtime and generated schema for safe outgoing Payment Request evaluation. */
export const paymentRequestEvaluationSchema = namedSchema(
  'PaymentRequestEvaluation',
  objectNode(
    {
      amount: decimalAmountNode,
      unit: stringNode({ pattern: '\\S' }),
      transport: objectNode({ type: enumNode(['inband', 'http', 'nostr']) }),
      allowedMints: arrayNode(stringNode()),
      payableMints: arrayNode(stringNode()),
      spendingCondition: paymentRequestSpendingConditionNode,
    },
    { optional: ['amount', 'spendingCondition'] },
  ),
);

/** Runtime and generated schema for method-specific Mint Quote creation. */
export const createMintQuoteRequestSchema = namedSchema(
  'CreateMintQuoteRequest',
  quoteMethodUnionNode('mint', [
    objectNode(
      {
        mintUrl: stringNode(),
        method: literalNode('bolt11'),
        amount: positiveDecimalAmountNode,
        unit: stringNode(),
        locked: booleanNode(),
      },
      { optional: ['mintUrl', 'locked'] },
    ),
    objectNode({
      mintUrl: stringNode(),
      method: literalNode('onchain'),
      unit: stringNode(),
    }),
    objectNode(
      {
        mintUrl: stringNode(),
        method: literalNode('bolt12'),
        unit: stringNode(),
        amount: positiveDecimalAmountNode,
        description: stringNode(),
      },
      { optional: ['amount', 'description'] },
    ),
  ]),
);

const mintQuoteBaseFields = {
  type: literalNode('mint'),
  mintUrl: stringNode(),
  quoteId: stringNode(),
  request: stringNode(),
  unit: stringNode(),
  amountPaid: decimalAmountNode,
  amountIssued: decimalAmountNode,
  expiry: nullableNode(rfc3339UtcSchema),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const mintQuoteNode = unionNode([
  objectNode({
    ...mintQuoteBaseFields,
    method: literalNode('bolt11'),
    amount: decimalAmountNode,
    reusable: literalNode(false),
    state: enumNode(['UNPAID', 'PAID', 'ISSUED']),
  }),
  objectNode(
    {
      ...mintQuoteBaseFields,
      method: literalNode('bolt12'),
      amount: decimalAmountNode,
      reusable: literalNode(true),
    },
    { optional: ['amount'] },
  ),
  objectNode({
    ...mintQuoteBaseFields,
    method: literalNode('onchain'),
    reusable: literalNode(true),
  }),
]);

/** Runtime and generated schema for one safe canonical Mint Quote. */
export const mintQuoteSchema = namedSchema('MintQuote', mintQuoteNode);

/** Runtime and generated schema for pending canonical Mint Quotes. */
export const pendingMintQuotesSchema = namedSchema(
  'PendingMintQuotes',
  objectNode({
    items: arrayNode(mintQuoteNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

/** Runtime and generated schema for method-specific Melt Quote creation. */
export const createMeltQuoteRequestSchema = namedSchema(
  'CreateMeltQuoteRequest',
  quoteMethodUnionNode('melt', [
    objectNode(
      {
        mintUrl: stringNode(),
        method: literalNode('bolt11'),
        invoice: stringNode(),
        amount: positiveDecimalAmountNode,
        unit: stringNode(),
      },
      { optional: ['mintUrl', 'amount', 'unit'] },
    ),
    objectNode(
      {
        mintUrl: stringNode(),
        method: literalNode('bolt12'),
        offer: stringNode(),
        amount: positiveDecimalAmountNode,
        unit: stringNode(),
      },
      { optional: ['amount', 'unit'] },
    ),
    objectNode(
      {
        mintUrl: stringNode(),
        method: literalNode('onchain'),
        address: stringNode(),
        amount: positiveDecimalAmountNode,
        unit: stringNode(),
      },
      { optional: ['unit'] },
    ),
  ]),
);

const meltQuoteBaseFields = {
  type: literalNode('melt'),
  mintUrl: stringNode(),
  quoteId: stringNode(),
  request: stringNode(),
  unit: stringNode(),
  amount: decimalAmountNode,
  state: enumNode(['UNPAID', 'PENDING', 'PAID']),
  expiry: rfc3339UtcSchema,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const boltMeltQuoteFields = {
  ...meltQuoteBaseFields,
  feeReserve: decimalAmountNode,
};

const meltQuoteNode = unionNode([
  objectNode({ ...boltMeltQuoteFields, method: literalNode('bolt11') }),
  objectNode({ ...boltMeltQuoteFields, method: literalNode('bolt12') }),
  objectNode({
    ...meltQuoteBaseFields,
    method: literalNode('onchain'),
    feeOptions: arrayNode(
      objectNode({
        feeIndex: integerNode({ minimum: 0 }),
        feeReserve: decimalAmountNode,
        estimatedBlocks: integerNode({ minimum: 0 }),
      }),
    ),
  }),
]);

/** Runtime and generated schema for one safe canonical Melt Quote. */
export const meltQuoteSchema = namedSchema('MeltQuote', meltQuoteNode);

/** Runtime and generated schema for pending canonical Melt Quotes. */
export const pendingMeltQuotesSchema = namedSchema(
  'PendingMeltQuotes',
  objectNode({
    items: arrayNode(meltQuoteNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

/** Runtime and generated schema for quote-backed Mint Operation preparation. */
export const createMintOperationRequestSchema = namedSchema(
  'CreateMintOperationRequest',
  objectNode({
    mintUrl: stringNode(),
    quoteId: stringNode({ pattern: '\\S' }),
    amount: positiveDecimalAmountNode,
  }),
);

const mintOperationFailureNode = objectNode(
  {
    reason: stringNode(),
    code: stringNode(),
    retryable: booleanNode(),
    observedAt: rfc3339UtcSchema,
  },
  { optional: ['code', 'retryable'] },
);

const mintOperationNode = objectNode(
  {
    id: stringNode(),
    type: literalNode('mint'),
    state: enumNode(['init', 'pending', 'executing', 'finalized', 'failed']),
    mintUrl: stringNode(),
    unit: stringNode(),
    method: enumNode(['bolt11', 'bolt12', 'onchain']),
    amount: decimalAmountNode,
    quote: objectNode({ mintUrl: stringNode(), quoteId: stringNode() }),
    expiry: nullableNode(rfc3339UtcSchema),
    failure: mintOperationFailureNode,
    createdAt: rfc3339UtcSchema,
    updatedAt: rfc3339UtcSchema,
  },
  { optional: ['expiry', 'failure'] },
);

/** Runtime and generated schema for one safe Mint Operation. */
export const mintOperationSchema = namedSchema('MintOperation', mintOperationNode);

/** Runtime and generated schema for paginated safe Mint Operations. */
export const mintOperationsSchema = namedSchema(
  'MintOperations',
  objectNode({
    items: arrayNode(mintOperationNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

/** Runtime and generated schema for quote-backed Melt Operation preparation. */
export const createMeltOperationRequestSchema = namedSchema(
  'CreateMeltOperationRequest',
  objectNode(
    {
      mintUrl: stringNode(),
      quoteId: stringNode({ pattern: '\\S' }),
      feeIndex: integerNode({ minimum: 0 }),
    },
    { optional: ['feeIndex'] },
  ),
);

const meltOperationBaseFields = {
  id: stringNode(),
  type: literalNode('melt'),
  mintUrl: stringNode(),
  unit: stringNode(),
  method: enumNode(['bolt11', 'bolt12', 'onchain']),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const meltOperationQuoteNode = objectNode({ mintUrl: stringNode(), quoteId: stringNode() });
const meltOperationNode = unionNode([
  objectNode(
    {
      ...meltOperationBaseFields,
      state: literalNode('init'),
      quote: meltOperationQuoteNode,
    },
    { optional: ['quote'] },
  ),
  objectNode(
    {
      ...meltOperationBaseFields,
      state: enumNode([
        'prepared',
        'executing',
        'pending',
        'failed',
        'finalized',
        'rolling_back',
        'rolled_back',
      ]),
      amount: decimalAmountNode,
      quote: meltOperationQuoteNode,
      feeReserve: decimalAmountNode,
      swapFee: decimalAmountNode,
      inputAmount: decimalAmountNode,
      needsSwap: booleanNode(),
      feeIndex: integerNode({ minimum: 0 }),
      changeAmount: decimalAmountNode,
      effectiveFee: decimalAmountNode,
    },
    { optional: ['feeIndex', 'changeAmount', 'effectiveFee'] },
  ),
]);

/** Runtime and generated schema for one safe Melt Operation. */
export const meltOperationSchema = namedSchema('MeltOperation', meltOperationNode);

/** Runtime and generated schema for paginated safe Melt Operations. */
export const meltOperationsSchema = namedSchema(
  'MeltOperations',
  objectNode({
    items: arrayNode(meltOperationNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

const meltResultNode = unionNode([
  objectNode({ preimage: stringNode({ sensitive: true }) }),
  objectNode({ outpoint: stringNode({ sensitive: true }) }),
]);

/** Runtime and generated schema for a sensitive Melt Operation settlement result. */
export const meltResultSchema = namedSchema('MeltResult', meltResultNode);

/** Runtime and generated schema for Melt Operation execution. */
export const executeMeltOperationResponseSchema = namedSchema(
  'ExecuteMeltOperationResponse',
  objectNode({ operation: meltOperationNode, result: meltResultNode }, { optional: ['result'] }),
);

const paymentRequestSendSourceNode = objectNode({
  type: literalNode('payment-request'),
  request: stringNode({ pattern: '\\S', sensitive: true }),
});

/** Runtime and generated schema for Cashu Send Operation preparation. */
export const createSendOperationRequestSchema = namedSchema(
  'CreateSendOperationRequest',
  unionNode([
    objectNode(
      {
        mintUrl: stringNode(),
        amount: positiveDecimalAmountNode,
        unit: stringNode({ pattern: '\\S' }),
        forceSwap: booleanNode(),
      },
      { optional: ['mintUrl', 'forceSwap'] },
    ),
    objectNode(
      {
        mintUrl: stringNode(),
        source: paymentRequestSendSourceNode,
      },
      { optional: ['mintUrl'] },
    ),
    objectNode(
      {
        mintUrl: stringNode(),
        source: paymentRequestSendSourceNode,
        amount: positiveDecimalAmountNode,
        unit: stringNode({ pattern: '\\S' }),
      },
      { optional: ['mintUrl', 'unit'] },
    ),
  ]),
);

const sendOperationBaseFields = {
  id: stringNode(),
  type: literalNode('send'),
  mintUrl: stringNode(),
  unit: stringNode(),
  method: enumNode(['default', 'p2pk']),
  requestedAmount: decimalAmountNode,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const sendOperationNode = unionNode([
  objectNode({ ...sendOperationBaseFields, state: literalNode('init') }),
  objectNode({
    ...sendOperationBaseFields,
    state: enumNode([
      'prepared',
      'executing',
      'pending',
      'finalized',
      'rolling_back',
      'rolled_back',
    ]),
    inputAmount: decimalAmountNode,
    fee: decimalAmountNode,
    needsSwap: booleanNode(),
  }),
]);

/** Runtime and generated schema for one safe Send Operation. */
export const sendOperationSchema = namedSchema('SendOperation', sendOperationNode);

/** Runtime and generated schema for paginated safe Send Operations. */
export const sendOperationsSchema = namedSchema(
  'SendOperations',
  objectNode({
    items: arrayNode(sendOperationNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

const sendResultNode = objectNode({ token: stringNode({ sensitive: true }) });

/** Runtime and generated schema for a sensitive Send Operation result. */
export const sendResultSchema = namedSchema('SendResult', sendResultNode);

/** Runtime and generated schema for Send Operation execution with its result. */
export const executeSendOperationResponseSchema = namedSchema(
  'ExecuteSendOperationResponse',
  objectNode({ operation: sendOperationNode, result: sendResultNode }),
);

/** Runtime and generated schema for Cashu Receive Operation preparation. */
export const createReceiveOperationRequestSchema = namedSchema(
  'CreateReceiveOperationRequest',
  objectNode({ token: stringNode({ pattern: '\\S', sensitive: true }) }),
);

const receiveOperationBaseFields = {
  id: stringNode(),
  type: literalNode('receive'),
  mintUrl: stringNode(),
  unit: stringNode(),
  amount: decimalAmountNode,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const receiveOperationNode = unionNode([
  objectNode({ ...receiveOperationBaseFields, state: literalNode('init') }),
  objectNode({
    ...receiveOperationBaseFields,
    state: enumNode(['prepared', 'executing', 'finalized', 'rolled_back']),
    fee: decimalAmountNode,
  }),
]);

/** Runtime and generated schema for one safe Receive Operation. */
export const receiveOperationSchema = namedSchema('ReceiveOperation', receiveOperationNode);

/** Runtime and generated schema for paginated safe Receive Operations. */
export const receiveOperationsSchema = namedSchema(
  'ReceiveOperations',
  objectNode({
    items: arrayNode(receiveOperationNode),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  }),
);

/** Common v1 error response returned without a legacy envelope. */
export type V1ErrorDocument = InferSchema<typeof v1ErrorSchema>;

/** Public process-liveness document that reveals no Wallet configuration or Wallet Seed Access. */
export type HealthDocument = InferSchema<typeof healthSchema>;

/** Authenticated Wallet, Seed Access, and Coco Session status document. */
export type LifecycleStatusDocument = InferSchema<typeof lifecycleStatusSchema>;

/** Network Wallet initialization input; recovery material is always generated by cocod. */
export type InitializeWalletRequest = InferSchema<typeof initializeWalletRequestSchema>;

/** Wallet Recovery Material retrieval input containing optional Wallet-unlocking material. */
export type WalletRecoveryMaterialRequest = InferSchema<typeof walletRecoveryMaterialRequestSchema>;

/** Coco Session start input containing optional Wallet-unlocking material. */
export type StartSessionRequest = InferSchema<typeof startSessionRequestSchema>;

/** Coco Session stop accepts an empty JSON object. */
export type StopSessionRequest = InferSchema<typeof stopSessionRequestSchema>;

/** Cocod Process shutdown accepts an empty JSON object. */
export type ProcessShutdownRequest = InferSchema<typeof processShutdownRequestSchema>;

/** Non-cacheable result returned after cocod durably configures its generated Wallet. */
export type InitializeWalletResponseDocument = InferSchema<typeof initializeWalletResponseSchema>;

/** Sensitive Wallet Recovery Material returned only by the administrative retrieval route. */
export type WalletRecoveryMaterialResponseDocument = InferSchema<
  typeof walletRecoveryMaterialResponseSchema
>;

/** Acknowledges that Cocod Process shutdown has been accepted. */
export type ProcessShutdownResponseDocument = InferSchema<typeof processShutdownResponseSchema>;

/** Flat collection of Wallet balances without cross-unit aggregation. */
export type BalancesDocument = InferSchema<typeof balancesSchema>;

/** Safe balance projection for one Known Mint and unit. */
export type BalanceDocument = BalancesDocument['items'][number];

/** Explicit safe projection of one Coco history entry. */
export type HistoryDocument = InferSchema<typeof historySchema>;

/** Offset-paginated safe Wallet history. */
export type HistoryPageDocument = InferSchema<typeof historyPageSchema>;

/** Safe, non-replayable hint that one canonical v1 resource changed. */
export type ResourceInvalidationEventDocument = InferSchema<typeof resourceInvalidationEventSchema>;

/** Body used by Known Mint registration and trust commands. */
export type MintUrlRequest = InferSchema<typeof mintUrlRequestSchema>;

/** Safe cocod projection of Coco's Known Mint model. */
export type KnownMintDocument = InferSchema<typeof knownMintSchema>;

/** Collection of Known Mints. */
export type KnownMintsDocument = InferSchema<typeof knownMintsSchema>;

/** Mint metadata resolved through Coco and scoped to its normalized identity. */
export type MintInformationDocument = InferSchema<typeof mintInformationSchema>;

/** Collection of capabilities advertised by one Known Mint. */
export type PaymentMethodCapabilitiesDocument = InferSchema<typeof paymentMethodCapabilitiesSchema>;

/** Safe projection of one Coco Payment Method Capability. */
export type PaymentMethodCapabilityDocument = PaymentMethodCapabilitiesDocument['items'][number];

/** Encoded outgoing Payment Request supplied for non-mutating evaluation. */
export type EvaluatePaymentRequestRequest = InferSchema<typeof evaluatePaymentRequestRequestSchema>;

/** Safe, non-durable evaluation of an outgoing Payment Request. */
export type PaymentRequestEvaluationDocument = InferSchema<typeof paymentRequestEvaluationSchema>;

/** Safe spending-condition requirement exposed by outgoing Payment Request evaluation. */
export type PaymentRequestSpendingConditionDocument = NonNullable<
  PaymentRequestEvaluationDocument['spendingCondition']
>;

/** Method-specific Mint Quote creation input with lossless decimal amounts. */
export type CreateMintQuoteRequest = InferSchema<typeof createMintQuoteRequestSchema>;

/** Safe cocod projection of one canonical Mint Quote. */
export type MintQuoteDocument = InferSchema<typeof mintQuoteSchema>;

/** Offset-paginated canonical Mint Quotes. */
export type PendingMintQuotesDocument = InferSchema<typeof pendingMintQuotesSchema>;

/** Method-specific Melt Quote creation input with lossless decimal amounts. */
export type CreateMeltQuoteRequest = InferSchema<typeof createMeltQuoteRequestSchema>;

/** Safe cocod projection of one canonical Melt Quote. */
export type MeltQuoteDocument = InferSchema<typeof meltQuoteSchema>;

/** Offset-paginated canonical Melt Quotes. */
export type PendingMeltQuotesDocument = InferSchema<typeof pendingMeltQuotesSchema>;

/** Quote-backed Mint Operation preparation input with a lossless decimal amount. */
export type CreateMintOperationRequest = InferSchema<typeof createMintOperationRequestSchema>;

/** Explicit safe projection of one Coco Mint Operation. */
export type MintOperationDocument = InferSchema<typeof mintOperationSchema>;

/** Safe terminal failure information retained by a Mint Operation. */
export type MintOperationFailureDocument = NonNullable<MintOperationDocument['failure']>;

/** Offset-paginated safe Mint Operations. */
export type MintOperationsDocument = InferSchema<typeof mintOperationsSchema>;

/** Quote-backed Melt Operation preparation input. */
export type CreateMeltOperationRequest = InferSchema<typeof createMeltOperationRequestSchema>;

/** Explicit safe projection of one Coco Melt Operation. */
export type MeltOperationDocument = InferSchema<typeof meltOperationSchema>;

/** Offset-paginated safe Melt Operations. */
export type MeltOperationsDocument = InferSchema<typeof meltOperationsSchema>;

/** Sensitive settlement result retained by a finalized Melt Operation. */
export type MeltResultDocument = InferSchema<typeof meltResultSchema>;

/** Execute response pairing the safe Melt Operation with any available settlement result. */
export type ExecuteMeltOperationResponseDocument = InferSchema<
  typeof executeMeltOperationResponseSchema
>;

/** Cashu Send Operation preparation input, optionally sourced from a Payment Request. */
export type CreateSendOperationRequest = InferSchema<typeof createSendOperationRequestSchema>;

/** Explicit safe projection of one Coco Send Operation. */
export type SendOperationDocument = InferSchema<typeof sendOperationSchema>;

/** Offset-paginated safe Send Operations. */
export type SendOperationsDocument = InferSchema<typeof sendOperationsSchema>;

/** Sensitive, shareable result of a successfully executed Send Operation. */
export type SendResultDocument = InferSchema<typeof sendResultSchema>;

/** Execute response pairing the safe canonical Operation with its sensitive result. */
export type ExecuteSendOperationResponseDocument = InferSchema<
  typeof executeSendOperationResponseSchema
>;

/** Cashu Receive Operation preparation input containing an encoded token. */
export type CreateReceiveOperationRequest = InferSchema<typeof createReceiveOperationRequestSchema>;

/** Explicit safe projection of one Coco Receive Operation. */
export type ReceiveOperationDocument = InferSchema<typeof receiveOperationSchema>;

/** Offset-paginated safe Receive Operations. */
export type ReceiveOperationsDocument = InferSchema<typeof receiveOperationsSchema>;

/** Maps runtime-owned lifecycle state to its safe v1 representation. */
export function toLifecycleStatusDocument(
  status: CocodStatus,
  daemonVersion: string,
): LifecycleStatusDocument {
  return lifecycleStatusSchema.parse({
    daemon: { version: daemonVersion, interfaceVersion: INTERFACE_VERSION },
    wallet: status.wallet ? { configuredAt: status.wallet.configuredAt } : null,
    seedAccess: status.seedAccess,
    cocoSession: status.cocoSession,
  });
}

function namedSchema<Output>(name: string, node: SchemaNode<Output>): RuntimeSchema<Output> {
  return {
    name,
    jsonSchema: node.jsonSchema,
    parse(value) {
      return node.parse(value, '$');
    },
  };
}

function literalNode<T extends string | number | boolean | null>(expected: T): SchemaNode<T> {
  return {
    jsonSchema: expected === null ? { type: 'null' } : { const: expected },
    parse(value, path) {
      if (value !== expected) {
        throw new Error(`${path} must equal ${JSON.stringify(expected)}`);
      }
      return expected;
    },
  };
}

function anyNode(): SchemaNode<unknown> {
  return {
    jsonSchema: {},
    parse(value) {
      return value;
    },
  };
}

function stringNode(
  options: { format?: 'date-time'; pattern?: string; sensitive?: boolean } = {},
): SchemaNode<string> {
  return {
    jsonSchema: {
      type: 'string',
      ...(options.format ? { format: options.format } : {}),
      ...(options.pattern ? { pattern: options.pattern } : {}),
      ...(options.sensitive ? { 'x-sensitive': true } : {}),
    },
    parse(value, path) {
      if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
      }
      if (options.pattern && !new RegExp(options.pattern).test(value)) {
        throw new Error(`${path} does not match the required pattern`);
      }
      if (
        options.format === 'date-time' &&
        (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      ) {
        throw new Error(`${path} must be an RFC 3339 UTC timestamp`);
      }
      return value;
    },
  };
}

function booleanNode(): SchemaNode<boolean> {
  return {
    jsonSchema: { type: 'boolean' },
    parse(value, path) {
      if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
      }
      return value;
    },
  };
}

function integerNode(options: { minimum?: number; maximum?: number } = {}): SchemaNode<number> {
  return {
    jsonSchema: {
      type: 'integer',
      ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
    },
    parse(value, path) {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        (options.minimum !== undefined && value < options.minimum) ||
        (options.maximum !== undefined && value > options.maximum)
      ) {
        throw new Error(`${path} must be an integer in the allowed range`);
      }
      return value;
    },
  };
}

function arrayNode<Item>(item: SchemaNode<Item>): SchemaNode<Item[]> {
  return {
    jsonSchema: { type: 'array', items: item.jsonSchema },
    parse(value, path) {
      if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
      }
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
  };
}

function enumNode<const T extends readonly string[]>(values: T): SchemaNode<T[number]> {
  return {
    jsonSchema: { enum: values },
    parse(value, path) {
      const match = typeof value === 'string' ? values.find((entry) => entry === value) : undefined;
      if (match === undefined) {
        throw new Error(`${path} must be one of ${values.join(', ')}`);
      }
      return match;
    },
  };
}

function quoteMethodUnionNode<const Nodes extends readonly SchemaNode<unknown>[]>(
  type: 'mint' | 'melt',
  nodes: Nodes,
): SchemaNode<InferNode<Nodes[number]>> {
  const supportedMethods = ['bolt11', 'bolt12', 'onchain'];
  const supportedUnion = unionNode(nodes);
  return {
    jsonSchema: supportedUnion.jsonSchema,
    parse(value, path) {
      const record = requireRecord(value, path);
      const method = record.method;
      if (typeof method === 'string' && !supportedMethods.includes(method)) {
        throw new V1HttpError({
          status: 409,
          code: 'unsupported_behavior',
          message: `The ${type === 'mint' ? 'Mint' : 'Melt'} Quote method is unsupported`,
          retryable: false,
          details: { type, method },
        });
      }
      return supportedUnion.parse(value, path);
    },
  };
}

function nullableNode<Node extends SchemaNode<unknown>>(
  node: Node,
): SchemaNode<null | InferNode<Node>> {
  return unionNode([literalNode(null), node], 'anyOf');
}

function objectNode<const Properties extends SchemaProperties>(
  properties: Properties,
): SchemaNode<InferObject<Properties, never, false>>;
function objectNode<
  const Properties extends SchemaProperties,
  const Optional extends readonly (keyof Properties & string)[] | undefined,
  const AdditionalProperties extends boolean | undefined,
>(
  properties: Properties,
  options: { optional?: Optional; additionalProperties?: AdditionalProperties },
): SchemaNode<
  InferObject<
    Properties,
    Optional extends readonly (keyof Properties & string)[] ? Optional[number] : never,
    AdditionalProperties extends true ? true : false
  >
>;
function objectNode(
  properties: SchemaProperties,
  options: { optional?: readonly string[]; additionalProperties?: boolean } = {},
): SchemaNode<Record<string, unknown>> {
  const optional = new Set(options.optional ?? []);
  const additionalProperties = options.additionalProperties ?? false;
  const required = Object.keys(properties).filter((key) => !optional.has(key));
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties,
      required,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, node]) => [key, node.jsonSchema]),
      ),
    },
    parse(value, path) {
      const record = requireRecord(value, path);
      if (!additionalProperties) {
        requireOnlyKeys(record, Object.keys(properties), path);
      }
      const parsed: Record<string, unknown> = additionalProperties ? { ...record } : {};
      for (const [key, node] of Object.entries(properties)) {
        if (!(key in record)) {
          if (optional.has(key)) {
            continue;
          }
          throw new Error(`${path}.${key} is required`);
        }
        parsed[key] = node.parse(record[key], `${path}.${key}`);
      }
      return parsed;
    },
  };
}

function unionNode<const Nodes extends readonly SchemaNode<unknown>[]>(
  nodes: Nodes,
  keyword?: 'oneOf' | 'anyOf',
): SchemaNode<StrictUnion<InferNode<Nodes[number]>>>;
function unionNode(
  nodes: readonly SchemaNode<unknown>[],
  keyword: 'oneOf' | 'anyOf' = 'oneOf',
): SchemaNode<unknown> {
  return {
    jsonSchema: { [keyword]: nodes.map((node) => node.jsonSchema) },
    parse(value, path) {
      const matches: unknown[] = [];
      const errors: unknown[] = [];
      for (const node of nodes) {
        try {
          matches.push(node.parse(value, path));
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          errors.push(error);
        }
      }
      if (matches.length === 0 || (keyword === 'oneOf' && matches.length !== 1)) {
        throw new AggregateError(errors, `${path} does not match ${keyword}`);
      }
      return matches[0];
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains an unexpected field`);
  }
}
