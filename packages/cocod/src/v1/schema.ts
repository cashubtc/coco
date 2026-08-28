import { z } from 'zod';

import type { CocodStatus } from '../runtime.js';
import { V1HttpError } from './contract.js';

/** Runtime validator paired with the JSON Schema emitted for the same document. */
export interface RuntimeSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

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

const rfc3339UtcSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
  .meta({ format: 'date-time' });
const openObjectSchema = z.looseObject({}).meta({ additionalProperties: true });
const daemonStatusSchema = z.strictObject({
  version: z.string(),
  interfaceVersion: z.literal(INTERFACE_VERSION),
});
const walletStatusSchema = z.strictObject({ configuredAt: rfc3339UtcSchema });
const seedAccessStatusSchema = z.strictObject({
  state: z.enum(['locked', 'available']),
  requiresPassphrase: z.boolean(),
});
const lastFailureSchema = z.nullable(
  z.strictObject({
    code: z.string(),
    message: z.string(),
    occurredAt: rfc3339UtcSchema,
  }),
);
const cocoSessionStatusSchema = z.strictObject({
  state: z.enum(['stopped', 'starting', 'running', 'stopping', 'failed']),
  startedAt: z.nullable(rfc3339UtcSchema),
  lastFailure: lastFailureSchema,
});
const lifecycleStatusDocumentSchema = z.xor([
  z.strictObject({
    daemon: daemonStatusSchema,
    wallet: z.literal(null),
    seedAccess: z.literal(null),
    cocoSession: cocoSessionStatusSchema,
  }),
  z.strictObject({
    daemon: daemonStatusSchema,
    wallet: walletStatusSchema,
    seedAccess: seedAccessStatusSchema,
    cocoSession: cocoSessionStatusSchema,
  }),
]);
const sensitiveStringSchema = z.string().meta({ 'x-sensitive': true });
const nonEmptyStringSchema = z.string().regex(/\S/);
const nonEmptySensitiveStringSchema = nonEmptyStringSchema.meta({ 'x-sensitive': true });
const sensitivePassphraseRequestSchema = z.strictObject({
  passphrase: sensitiveStringSchema.optional(),
});

/** Runtime schema for a route that accepts no request body. */
export const noBodySchema = namedSchema('NoBody', z.literal(null));

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
  z.strictObject({
    status: z.literal('ok'),
    interfaceVersion: z.literal(INTERFACE_VERSION),
  }),
);

/** Shallow runtime guard for the generated OpenAPI document returned by cocod. */
export const openApiDocumentSchema: RuntimeSchema<unknown> = namedSchema(
  'OpenApiDocument',
  z.looseObject({
    openapi: z.literal('3.1.0'),
    info: openObjectSchema,
    paths: openObjectSchema,
    components: openObjectSchema,
  }),
);

/** Runtime and generated schema for the common v1 error document. */
export const v1ErrorSchema = namedSchema(
  'Error',
  z.strictObject({
    error: z.strictObject({
      code: z.enum(V1_ERROR_CODES),
      message: z.string(),
      retryable: z.boolean(),
      details: openObjectSchema.optional(),
    }),
  }),
);

/** Runtime and generated schema for authenticated lifecycle status. */
export const lifecycleStatusSchema = namedSchema('LifecycleStatus', lifecycleStatusDocumentSchema);

/** Runtime and generated schema for Wallet initialization requests. */
export const initializeWalletRequestSchema = namedSchema(
  'InitializeWalletRequest',
  sensitivePassphraseRequestSchema,
);

/** Runtime and generated schema for Wallet Recovery Material retrieval requests. */
export const walletRecoveryMaterialRequestSchema = namedSchema(
  'WalletRecoveryMaterialRequest',
  sensitivePassphraseRequestSchema,
);

/** Runtime and generated schema for Coco Session start requests. */
export const startSessionRequestSchema = namedSchema(
  'StartSessionRequest',
  sensitivePassphraseRequestSchema,
);

/** Runtime and generated schema for Coco Session stop requests. */
export const stopSessionRequestSchema = namedSchema(
  'StopSessionRequest',
  z.record(z.string(), z.never()),
);

/** Runtime and generated schema for Cocod Process shutdown requests. */
export const processShutdownRequestSchema = namedSchema(
  'ProcessShutdownRequest',
  z.record(z.string(), z.never()),
);

/** Runtime and generated schema for the sensitive Wallet initialization response. */
export const initializeWalletResponseSchema = namedSchema(
  'InitializeWalletResponse',
  z.strictObject({
    generatedMnemonic: sensitiveStringSchema,
    status: lifecycleStatusDocumentSchema,
  }),
);

/** Runtime and generated schema for sensitive Wallet Recovery Material responses. */
export const walletRecoveryMaterialResponseSchema = namedSchema(
  'WalletRecoveryMaterialResponse',
  z.strictObject({ mnemonic: sensitiveStringSchema }),
);

/** Runtime and generated schema for accepted Cocod Process shutdown. */
export const processShutdownResponseSchema = namedSchema(
  'ProcessShutdownResponse',
  z.strictObject({ status: z.literal('stopping') }),
);

const decimalAmountSchema = z.string().regex(/^(0|[1-9]\d*)$/);
const positiveDecimalAmountSchema = z.string().regex(/^[1-9]\d*$/);

/** Runtime and generated schema for safe Wallet balances. */
export const balancesSchema = namedSchema(
  'Balances',
  z.strictObject({
    items: z.array(
      z.strictObject({
        mintUrl: z.string(),
        unit: z.string(),
        spendable: decimalAmountSchema,
        reserved: decimalAmountSchema,
        total: decimalAmountSchema,
      }),
    ),
  }),
);

const historyBaseFields = {
  id: nonEmptyStringSchema,
  source: z.enum(['operation', 'legacy']),
  operationId: nonEmptyStringSchema,
  state: nonEmptyStringSchema,
  mintUrl: nonEmptyStringSchema,
  unit: nonEmptyStringSchema,
  amount: decimalAmountSchema,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const historyDocumentSchema = z.xor([
  z.strictObject({
    ...historyBaseFields,
    type: z.literal('mint'),
    operationId: nonEmptyStringSchema.optional(),
    quoteId: nonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    ...historyBaseFields,
    type: z.literal('melt'),
    operationId: nonEmptyStringSchema.optional(),
    quoteId: nonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    ...historyBaseFields,
    type: z.literal('send'),
    operationId: nonEmptyStringSchema.optional(),
  }),
  z.strictObject({
    ...historyBaseFields,
    type: z.literal('receive'),
    operationId: nonEmptyStringSchema.optional(),
  }),
]);

/** Runtime and generated schema for one safe Wallet history entry. */
export const historySchema = namedSchema('History', historyDocumentSchema);

/** Runtime and generated schema for offset-paginated safe Wallet history. */
export const historyPageSchema = namedSchema(
  'HistoryPage',
  z.strictObject({
    items: z.array(historyDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1).max(100),
  }),
);

const invalidationTimestamp = rfc3339UtcSchema;
const mintInvalidationDataSchema = z.strictObject({ mintUrl: nonEmptyStringSchema });

/** Runtime and generated schema for one SSE resource invalidation event. */
export const resourceInvalidationEventSchema = namedSchema(
  'ResourceInvalidationEvent',
  z.xor([
    z.strictObject({
      type: z.literal('history.updated'),
      timestamp: invalidationTimestamp,
      data: historyDocumentSchema,
    }),
    z.strictObject({
      type: z.literal('operation.updated'),
      timestamp: invalidationTimestamp,
      data: z.strictObject({
        operationType: z.enum(['mint', 'melt', 'send', 'receive']),
        operationId: nonEmptyStringSchema,
        mintUrl: nonEmptyStringSchema,
      }),
    }),
    z.strictObject({
      type: z.literal('quote.updated'),
      timestamp: invalidationTimestamp,
      data: z.strictObject({
        quoteType: z.enum(['mint', 'melt']),
        mintUrl: nonEmptyStringSchema,
        method: nonEmptyStringSchema,
        quoteId: nonEmptyStringSchema,
      }),
    }),
    z.strictObject({
      type: z.literal('mint.updated'),
      timestamp: invalidationTimestamp,
      data: mintInvalidationDataSchema,
    }),
    z.strictObject({
      type: z.literal('balance.updated'),
      timestamp: invalidationTimestamp,
      data: mintInvalidationDataSchema,
    }),
  ]),
);

const knownMintDocumentSchema = z.strictObject({
  mintUrl: z.string(),
  name: z.string(),
  trusted: z.boolean(),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
});

/** Runtime and generated schema for a request identifying a Mint by URL. */
export const mintUrlRequestSchema = namedSchema(
  'MintUrlRequest',
  z.strictObject({ mintUrl: z.string() }),
);

/** Runtime and generated schema for one safe Known Mint resource. */
export const knownMintSchema = namedSchema('KnownMint', knownMintDocumentSchema);

/** Runtime and generated schema for the Known Mint collection. */
export const knownMintsSchema = namedSchema(
  'KnownMints',
  z.strictObject({ items: z.array(knownMintDocumentSchema) }),
);

/** Runtime and generated schema for refreshed Mint metadata. */
export const mintInformationSchema = namedSchema(
  'MintInformation',
  z.strictObject({
    mintUrl: z.string(),
    info: openObjectSchema,
  }),
);

const paymentMethodCapabilitySchema = z.strictObject({
  operation: z.enum(['mint', 'melt']),
  nut: z.xor([z.literal(4), z.literal(5)]),
  method: z.string(),
  unit: z.string(),
  minAmount: z.nullable(decimalAmountSchema).optional(),
  maxAmount: z.nullable(decimalAmountSchema).optional(),
  options: z.unknown().optional(),
});

/** Runtime and generated schema for Mint and Melt payment-method capabilities. */
export const paymentMethodCapabilitiesSchema = namedSchema(
  'PaymentMethodCapabilities',
  z.strictObject({ items: z.array(paymentMethodCapabilitySchema) }),
);

/** Runtime and generated schema for outgoing Payment Request evaluation input. */
export const evaluatePaymentRequestRequestSchema = namedSchema(
  'EvaluatePaymentRequestRequest',
  z.strictObject({ request: nonEmptySensitiveStringSchema }),
);

const paymentRequestSpendingConditionSchema = z.xor([
  z.strictObject({ kind: z.literal('P2PK') }),
  z.strictObject({ kind: z.literal('unsupported'), nut10Kind: z.string() }),
  z.strictObject({ kind: z.literal('malformed'), nut10Kind: z.string() }),
]);

/** Runtime and generated schema for safe outgoing Payment Request evaluation. */
export const paymentRequestEvaluationSchema = namedSchema(
  'PaymentRequestEvaluation',
  z.strictObject({
    amount: decimalAmountSchema.optional(),
    unit: nonEmptyStringSchema,
    transport: z.strictObject({ type: z.enum(['inband', 'http', 'nostr']) }),
    allowedMints: z.array(z.string()),
    payableMints: z.array(z.string()),
    spendingCondition: paymentRequestSpendingConditionSchema.optional(),
  }),
);

/** Runtime and generated schema for method-specific Mint Quote creation. */
export const createMintQuoteRequestSchema = quoteMethodSchema(
  'CreateMintQuoteRequest',
  'mint',
  z.xor([
    z.strictObject({
      mintUrl: z.string().optional(),
      method: z.literal('bolt11'),
      amount: positiveDecimalAmountSchema,
      unit: z.string(),
      locked: z.boolean().optional(),
    }),
    z.strictObject({
      mintUrl: z.string(),
      method: z.literal('onchain'),
      unit: z.string(),
    }),
    z.strictObject({
      mintUrl: z.string(),
      method: z.literal('bolt12'),
      unit: z.string(),
      amount: positiveDecimalAmountSchema.optional(),
      description: z.string().optional(),
    }),
  ]),
);

const mintQuoteBaseFields = {
  type: z.literal('mint'),
  mintUrl: z.string(),
  quoteId: z.string(),
  request: z.string(),
  unit: z.string(),
  amountPaid: decimalAmountSchema,
  amountIssued: decimalAmountSchema,
  expiry: z.nullable(rfc3339UtcSchema),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const mintQuoteDocumentSchema = z.xor([
  z.strictObject({
    ...mintQuoteBaseFields,
    method: z.literal('bolt11'),
    amount: decimalAmountSchema,
    reusable: z.literal(false),
    state: z.enum(['UNPAID', 'PAID', 'ISSUED']),
  }),
  z.strictObject({
    ...mintQuoteBaseFields,
    method: z.literal('bolt12'),
    amount: decimalAmountSchema.optional(),
    reusable: z.literal(true),
  }),
  z.strictObject({
    ...mintQuoteBaseFields,
    method: z.literal('onchain'),
    reusable: z.literal(true),
  }),
]);

/** Runtime and generated schema for one safe canonical Mint Quote. */
export const mintQuoteSchema = namedSchema('MintQuote', mintQuoteDocumentSchema);

/** Runtime and generated schema for pending canonical Mint Quotes. */
export const pendingMintQuotesSchema = namedSchema(
  'PendingMintQuotes',
  z.strictObject({
    items: z.array(mintQuoteDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

/** Runtime and generated schema for method-specific Melt Quote creation. */
export const createMeltQuoteRequestSchema = quoteMethodSchema(
  'CreateMeltQuoteRequest',
  'melt',
  z.xor([
    z.strictObject({
      mintUrl: z.string().optional(),
      method: z.literal('bolt11'),
      invoice: z.string(),
      amount: positiveDecimalAmountSchema.optional(),
      unit: z.string().optional(),
    }),
    z.strictObject({
      mintUrl: z.string(),
      method: z.literal('bolt12'),
      offer: z.string(),
      amount: positiveDecimalAmountSchema.optional(),
      unit: z.string().optional(),
    }),
    z.strictObject({
      mintUrl: z.string(),
      method: z.literal('onchain'),
      address: z.string(),
      amount: positiveDecimalAmountSchema,
      unit: z.string().optional(),
    }),
  ]),
);

const meltQuoteBaseFields = {
  type: z.literal('melt'),
  mintUrl: z.string(),
  quoteId: z.string(),
  request: z.string(),
  unit: z.string(),
  amount: decimalAmountSchema,
  state: z.enum(['UNPAID', 'PENDING', 'PAID']),
  expiry: rfc3339UtcSchema,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const boltMeltQuoteFields = {
  ...meltQuoteBaseFields,
  feeReserve: decimalAmountSchema,
};

const meltQuoteDocumentSchema = z.xor([
  z.strictObject({ ...boltMeltQuoteFields, method: z.literal('bolt11') }),
  z.strictObject({ ...boltMeltQuoteFields, method: z.literal('bolt12') }),
  z.strictObject({
    ...meltQuoteBaseFields,
    method: z.literal('onchain'),
    feeOptions: z.array(
      z.strictObject({
        feeIndex: z.int().min(0),
        feeReserve: decimalAmountSchema,
        estimatedBlocks: z.int().min(0),
      }),
    ),
  }),
]);

/** Runtime and generated schema for one safe canonical Melt Quote. */
export const meltQuoteSchema = namedSchema('MeltQuote', meltQuoteDocumentSchema);

/** Runtime and generated schema for pending canonical Melt Quotes. */
export const pendingMeltQuotesSchema = namedSchema(
  'PendingMeltQuotes',
  z.strictObject({
    items: z.array(meltQuoteDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

/** Runtime and generated schema for quote-backed Mint Operation preparation. */
export const createMintOperationRequestSchema = namedSchema(
  'CreateMintOperationRequest',
  z.strictObject({
    mintUrl: z.string(),
    quoteId: nonEmptyStringSchema,
    amount: positiveDecimalAmountSchema,
  }),
);

const mintOperationFailureSchema = z.strictObject({
  reason: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
  observedAt: rfc3339UtcSchema,
});

const mintOperationDocumentSchema = z.strictObject({
  id: z.string(),
  type: z.literal('mint'),
  state: z.enum(['init', 'pending', 'executing', 'finalized', 'failed']),
  mintUrl: z.string(),
  unit: z.string(),
  method: z.enum(['bolt11', 'bolt12', 'onchain']),
  amount: decimalAmountSchema,
  quote: z.strictObject({ mintUrl: z.string(), quoteId: z.string() }),
  expiry: z.nullable(rfc3339UtcSchema).optional(),
  failure: mintOperationFailureSchema.optional(),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
});

/** Runtime and generated schema for one safe Mint Operation. */
export const mintOperationSchema = namedSchema('MintOperation', mintOperationDocumentSchema);

/** Runtime and generated schema for paginated safe Mint Operations. */
export const mintOperationsSchema = namedSchema(
  'MintOperations',
  z.strictObject({
    items: z.array(mintOperationDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

/** Runtime and generated schema for quote-backed Melt Operation preparation. */
export const createMeltOperationRequestSchema = namedSchema(
  'CreateMeltOperationRequest',
  z.strictObject({
    mintUrl: z.string(),
    quoteId: nonEmptyStringSchema,
    feeIndex: z.int().min(0).optional(),
  }),
);

const meltOperationBaseFields = {
  id: z.string(),
  type: z.literal('melt'),
  mintUrl: z.string(),
  unit: z.string(),
  method: z.enum(['bolt11', 'bolt12', 'onchain']),
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const meltOperationQuoteSchema = z.strictObject({ mintUrl: z.string(), quoteId: z.string() });
const meltOperationDocumentSchema = z.xor([
  z.strictObject({
    ...meltOperationBaseFields,
    state: z.literal('init'),
    quote: meltOperationQuoteSchema.optional(),
  }),
  z.strictObject({
    ...meltOperationBaseFields,
    state: z.enum([
      'prepared',
      'executing',
      'pending',
      'failed',
      'finalized',
      'rolling_back',
      'rolled_back',
    ]),
    amount: decimalAmountSchema,
    quote: meltOperationQuoteSchema,
    feeReserve: decimalAmountSchema,
    swapFee: decimalAmountSchema,
    inputAmount: decimalAmountSchema,
    needsSwap: z.boolean(),
    feeIndex: z.int().min(0).optional(),
    changeAmount: decimalAmountSchema.optional(),
    effectiveFee: decimalAmountSchema.optional(),
  }),
]);

/** Runtime and generated schema for one safe Melt Operation. */
export const meltOperationSchema = namedSchema('MeltOperation', meltOperationDocumentSchema);

/** Runtime and generated schema for paginated safe Melt Operations. */
export const meltOperationsSchema = namedSchema(
  'MeltOperations',
  z.strictObject({
    items: z.array(meltOperationDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

const meltResultDocumentSchema = z.xor([
  z.strictObject({ preimage: sensitiveStringSchema, outpoint: z.never().optional() }),
  z.strictObject({ preimage: z.never().optional(), outpoint: sensitiveStringSchema }),
]);

/** Runtime and generated schema for a sensitive Melt Operation settlement result. */
export const meltResultSchema = namedSchema('MeltResult', meltResultDocumentSchema);

/** Runtime and generated schema for Melt Operation execution. */
export const executeMeltOperationResponseSchema = namedSchema(
  'ExecuteMeltOperationResponse',
  z.strictObject({
    operation: meltOperationDocumentSchema,
    result: meltResultDocumentSchema.optional(),
  }),
);

const paymentRequestSendSourceSchema = z.strictObject({
  type: z.literal('payment-request'),
  request: nonEmptySensitiveStringSchema,
});

/** Runtime and generated schema for Cashu Send Operation preparation. */
export const createSendOperationRequestSchema = namedSchema(
  'CreateSendOperationRequest',
  z.xor([
    z.strictObject({
      mintUrl: z.string().optional(),
      amount: positiveDecimalAmountSchema,
      unit: nonEmptyStringSchema,
      forceSwap: z.boolean().optional(),
      source: z.never().optional(),
    }),
    z.strictObject({
      mintUrl: z.string().optional(),
      source: paymentRequestSendSourceSchema,
      amount: z.never().optional(),
      unit: z.never().optional(),
      forceSwap: z.never().optional(),
    }),
    z.strictObject({
      mintUrl: z.string().optional(),
      source: paymentRequestSendSourceSchema,
      amount: positiveDecimalAmountSchema,
      unit: nonEmptyStringSchema.optional(),
      forceSwap: z.never().optional(),
    }),
  ]),
);

const sendOperationBaseFields = {
  id: z.string(),
  type: z.literal('send'),
  mintUrl: z.string(),
  unit: z.string(),
  method: z.enum(['default', 'p2pk']),
  requestedAmount: decimalAmountSchema,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const sendOperationDocumentSchema = z.xor([
  z.strictObject({ ...sendOperationBaseFields, state: z.literal('init') }),
  z.strictObject({
    ...sendOperationBaseFields,
    state: z.enum(['prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back']),
    inputAmount: decimalAmountSchema,
    fee: decimalAmountSchema,
    needsSwap: z.boolean(),
  }),
]);

/** Runtime and generated schema for one safe Send Operation. */
export const sendOperationSchema = namedSchema('SendOperation', sendOperationDocumentSchema);

/** Runtime and generated schema for paginated safe Send Operations. */
export const sendOperationsSchema = namedSchema(
  'SendOperations',
  z.strictObject({
    items: z.array(sendOperationDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

const sendResultDocumentSchema = z.strictObject({ token: sensitiveStringSchema });

/** Runtime and generated schema for a sensitive Send Operation result. */
export const sendResultSchema = namedSchema('SendResult', sendResultDocumentSchema);

/** Runtime and generated schema for Send Operation execution with its result. */
export const executeSendOperationResponseSchema = namedSchema(
  'ExecuteSendOperationResponse',
  z.strictObject({ operation: sendOperationDocumentSchema, result: sendResultDocumentSchema }),
);

/** Runtime and generated schema for Cashu Receive Operation preparation. */
export const createReceiveOperationRequestSchema = namedSchema(
  'CreateReceiveOperationRequest',
  z.strictObject({ token: nonEmptySensitiveStringSchema }),
);

const receiveOperationBaseFields = {
  id: z.string(),
  type: z.literal('receive'),
  mintUrl: z.string(),
  unit: z.string(),
  amount: decimalAmountSchema,
  createdAt: rfc3339UtcSchema,
  updatedAt: rfc3339UtcSchema,
};

const receiveOperationDocumentSchema = z.xor([
  z.strictObject({ ...receiveOperationBaseFields, state: z.literal('init') }),
  z.strictObject({
    ...receiveOperationBaseFields,
    state: z.enum(['prepared', 'executing', 'finalized', 'rolled_back']),
    fee: decimalAmountSchema,
  }),
]);

/** Runtime and generated schema for one safe Receive Operation. */
export const receiveOperationSchema = namedSchema(
  'ReceiveOperation',
  receiveOperationDocumentSchema,
);

/** Runtime and generated schema for paginated safe Receive Operations. */
export const receiveOperationsSchema = namedSchema(
  'ReceiveOperations',
  z.strictObject({
    items: z.array(receiveOperationDocumentSchema),
    offset: z.int().min(0),
    limit: z.int().min(1),
  }),
);

/** Common v1 error response returned without a legacy envelope. */
export type V1ErrorDocument = z.infer<typeof v1ErrorSchema.zodSchema>;

/** Public process-liveness document that reveals no Wallet configuration or Wallet Seed Access. */
export type HealthDocument = z.infer<typeof healthSchema.zodSchema>;

/** Authenticated Wallet, Seed Access, and Coco Session status document. */
export type LifecycleStatusDocument = z.infer<typeof lifecycleStatusSchema.zodSchema>;

/** Network Wallet initialization input; recovery material is always generated by cocod. */
export type InitializeWalletRequest = z.infer<typeof initializeWalletRequestSchema.zodSchema>;

/** Wallet Recovery Material retrieval input containing optional Wallet-unlocking material. */
export type WalletRecoveryMaterialRequest = z.infer<
  typeof walletRecoveryMaterialRequestSchema.zodSchema
>;

/** Coco Session start input containing optional Wallet-unlocking material. */
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema.zodSchema>;

/** Coco Session stop accepts an empty JSON object. */
export type StopSessionRequest = z.infer<typeof stopSessionRequestSchema.zodSchema>;

/** Cocod Process shutdown accepts an empty JSON object. */
export type ProcessShutdownRequest = z.infer<typeof processShutdownRequestSchema.zodSchema>;

/** Non-cacheable result returned after cocod durably configures its generated Wallet. */
export type InitializeWalletResponseDocument = z.infer<
  typeof initializeWalletResponseSchema.zodSchema
>;

/** Sensitive Wallet Recovery Material returned only by the administrative retrieval route. */
export type WalletRecoveryMaterialResponseDocument = z.infer<
  typeof walletRecoveryMaterialResponseSchema.zodSchema
>;

/** Acknowledges that Cocod Process shutdown has been accepted. */
export type ProcessShutdownResponseDocument = z.infer<
  typeof processShutdownResponseSchema.zodSchema
>;

/** Flat collection of Wallet balances without cross-unit aggregation. */
export type BalancesDocument = z.infer<typeof balancesSchema.zodSchema>;

/** Safe balance projection for one Known Mint and unit. */
export type BalanceDocument = BalancesDocument['items'][number];

/** Explicit safe projection of one Coco history entry. */
export type HistoryDocument = z.infer<typeof historySchema.zodSchema>;

/** Offset-paginated safe Wallet history. */
export type HistoryPageDocument = z.infer<typeof historyPageSchema.zodSchema>;

/** Safe, non-replayable hint that one canonical v1 resource changed. */
export type ResourceInvalidationEventDocument = z.infer<
  typeof resourceInvalidationEventSchema.zodSchema
>;

/** Body used by Known Mint registration and trust commands. */
export type MintUrlRequest = z.infer<typeof mintUrlRequestSchema.zodSchema>;

/** Safe cocod projection of Coco's Known Mint model. */
export type KnownMintDocument = z.infer<typeof knownMintSchema.zodSchema>;

/** Collection of Known Mints. */
export type KnownMintsDocument = z.infer<typeof knownMintsSchema.zodSchema>;

/** Mint metadata resolved through Coco and scoped to its normalized identity. */
export type MintInformationDocument = z.infer<typeof mintInformationSchema.zodSchema>;

/** Collection of capabilities advertised by one Known Mint. */
export type PaymentMethodCapabilitiesDocument = z.infer<
  typeof paymentMethodCapabilitiesSchema.zodSchema
>;

/** Safe projection of one Coco Payment Method Capability. */
export type PaymentMethodCapabilityDocument = PaymentMethodCapabilitiesDocument['items'][number];

/** Encoded outgoing Payment Request supplied for non-mutating evaluation. */
export type EvaluatePaymentRequestRequest = z.infer<
  typeof evaluatePaymentRequestRequestSchema.zodSchema
>;

/** Safe, non-durable evaluation of an outgoing Payment Request. */
export type PaymentRequestEvaluationDocument = z.infer<
  typeof paymentRequestEvaluationSchema.zodSchema
>;

/** Safe spending-condition requirement exposed by outgoing Payment Request evaluation. */
export type PaymentRequestSpendingConditionDocument = NonNullable<
  PaymentRequestEvaluationDocument['spendingCondition']
>;

/** Method-specific Mint Quote creation input with lossless decimal amounts. */
export type CreateMintQuoteRequest = z.infer<typeof createMintQuoteRequestSchema.zodSchema>;

/** Safe cocod projection of one canonical Mint Quote. */
export type MintQuoteDocument = z.infer<typeof mintQuoteSchema.zodSchema>;

/** Offset-paginated canonical Mint Quotes. */
export type PendingMintQuotesDocument = z.infer<typeof pendingMintQuotesSchema.zodSchema>;

/** Method-specific Melt Quote creation input with lossless decimal amounts. */
export type CreateMeltQuoteRequest = z.infer<typeof createMeltQuoteRequestSchema.zodSchema>;

/** Safe cocod projection of one canonical Melt Quote. */
export type MeltQuoteDocument = z.infer<typeof meltQuoteSchema.zodSchema>;

/** Offset-paginated canonical Melt Quotes. */
export type PendingMeltQuotesDocument = z.infer<typeof pendingMeltQuotesSchema.zodSchema>;

/** Quote-backed Mint Operation preparation input with a lossless decimal amount. */
export type CreateMintOperationRequest = z.infer<typeof createMintOperationRequestSchema.zodSchema>;

/** Explicit safe projection of one Coco Mint Operation. */
export type MintOperationDocument = z.infer<typeof mintOperationSchema.zodSchema>;

/** Safe terminal failure information retained by a Mint Operation. */
export type MintOperationFailureDocument = NonNullable<MintOperationDocument['failure']>;

/** Offset-paginated safe Mint Operations. */
export type MintOperationsDocument = z.infer<typeof mintOperationsSchema.zodSchema>;

/** Quote-backed Melt Operation preparation input. */
export type CreateMeltOperationRequest = z.infer<typeof createMeltOperationRequestSchema.zodSchema>;

/** Explicit safe projection of one Coco Melt Operation. */
export type MeltOperationDocument = z.infer<typeof meltOperationSchema.zodSchema>;

/** Offset-paginated safe Melt Operations. */
export type MeltOperationsDocument = z.infer<typeof meltOperationsSchema.zodSchema>;

/** Sensitive settlement result retained by a finalized Melt Operation. */
export type MeltResultDocument = z.infer<typeof meltResultSchema.zodSchema>;

/** Execute response pairing the safe Melt Operation with any available settlement result. */
export type ExecuteMeltOperationResponseDocument = z.infer<
  typeof executeMeltOperationResponseSchema.zodSchema
>;

/** Cashu Send Operation preparation input, optionally sourced from a Payment Request. */
export type CreateSendOperationRequest = z.infer<typeof createSendOperationRequestSchema.zodSchema>;

/** Explicit safe projection of one Coco Send Operation. */
export type SendOperationDocument = z.infer<typeof sendOperationSchema.zodSchema>;

/** Offset-paginated safe Send Operations. */
export type SendOperationsDocument = z.infer<typeof sendOperationsSchema.zodSchema>;

/** Sensitive, shareable result of a successfully executed Send Operation. */
export type SendResultDocument = z.infer<typeof sendResultSchema.zodSchema>;

/** Execute response pairing the safe canonical Operation with its sensitive result. */
export type ExecuteSendOperationResponseDocument = z.infer<
  typeof executeSendOperationResponseSchema.zodSchema
>;

/** Cashu Receive Operation preparation input containing an encoded token. */
export type CreateReceiveOperationRequest = z.infer<
  typeof createReceiveOperationRequestSchema.zodSchema
>;

/** Explicit safe projection of one Coco Receive Operation. */
export type ReceiveOperationDocument = z.infer<typeof receiveOperationSchema.zodSchema>;

/** Offset-paginated safe Receive Operations. */
export type ReceiveOperationsDocument = z.infer<typeof receiveOperationsSchema.zodSchema>;

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

type ZodRuntimeSchema<Schema extends z.ZodType> = RuntimeSchema<z.output<Schema>> & {
  readonly zodSchema: Schema;
};

function namedSchema<const Schema extends z.ZodType>(
  name: string,
  zodSchema: Schema,
): ZodRuntimeSchema<Schema> {
  const { $schema: _dialect, ...jsonSchema } = z.toJSONSchema(zodSchema, {
    target: 'draft-2020-12',
  });
  return { name, zodSchema, jsonSchema, parse: (value) => zodSchema.parse(value) };
}

function quoteMethodSchema<const Schema extends z.ZodType>(
  name: string,
  type: 'mint' | 'melt',
  zodSchema: Schema,
): ZodRuntimeSchema<Schema> {
  const runtimeSchema = namedSchema(name, zodSchema);
  return {
    ...runtimeSchema,
    parse(value) {
      const methodResult = z.looseObject({ method: z.string() }).safeParse(value);
      if (
        methodResult.success &&
        !['bolt11', 'bolt12', 'onchain'].includes(methodResult.data.method)
      ) {
        throw new V1HttpError({
          status: 409,
          code: 'unsupported_behavior',
          message: `The ${type === 'mint' ? 'Mint' : 'Melt'} Quote method is unsupported`,
          retryable: false,
          details: { type, method: methodResult.data.method },
        });
      }
      return runtimeSchema.parse(value);
    },
  };
}
