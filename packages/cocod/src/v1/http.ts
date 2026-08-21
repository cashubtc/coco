import {
  normalizeMintUrl,
  parseHistoryEntryId,
  MeltOperationNotFoundError,
  MeltOperationStateError,
  MintOperationNotFoundError,
  MintOperationStateError,
  OperationInProgressError,
  PaymentRequestError,
  ReceiveOperationNotFoundError,
  ReceiveOperationStateError,
  SendOperationNotFoundError,
  SendOperationStateError,
  UnitValidationError,
  type BalanceQuery,
  type HistoryEntry,
  type Mint,
  type MintOperation,
  type MintQuote,
  type MeltOperation,
  type MeltQuote,
  type ReceiveOperation,
  type SendOperation,
  type CoreEvents,
} from '@cashu/coco-core';

import { CocodRuntimeError } from '../runtime-error.js';
import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  V1HttpError,
  V1HttpResponse,
  V1HttpStreamResponse,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
  type V1RouteParameter,
} from './contract.js';
import { generateV1OpenApiDocument } from './interface-description.js';
import {
  balancesSchema,
  createMintOperationRequestSchema,
  createMeltOperationRequestSchema,
  createMintQuoteRequestSchema,
  createMeltQuoteRequestSchema,
  createReceiveOperationRequestSchema,
  createSendOperationRequestSchema,
  evaluatePaymentRequestRequestSchema,
  executeSendOperationResponseSchema,
  executeMeltOperationResponseSchema,
  healthSchema,
  historyPageSchema,
  historySchema,
  initializeWalletRequestSchema,
  initializeWalletResponseSchema,
  knownMintSchema,
  knownMintsSchema,
  lifecycleStatusSchema,
  mintInformationSchema,
  mintOperationSchema,
  mintOperationsSchema,
  meltOperationSchema,
  meltOperationsSchema,
  meltResultSchema,
  meltQuoteSchema,
  mintQuoteSchema,
  mintUrlRequestSchema,
  noSuccessResponseSchema,
  paymentMethodCapabilitiesSchema,
  paymentRequestEvaluationSchema,
  noBodySchema,
  openApiDocumentSchema,
  pendingMintQuotesSchema,
  pendingMeltQuotesSchema,
  processShutdownRequestSchema,
  processShutdownResponseSchema,
  resourceInvalidationEventSchema,
  receiveOperationSchema,
  receiveOperationsSchema,
  sendOperationSchema,
  sendOperationsSchema,
  sendResultSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  toLifecycleStatusDocument,
  walletRecoveryMaterialRequestSchema,
  walletRecoveryMaterialResponseSchema,
  type BalancesDocument,
  type CreateMintOperationRequest,
  type CreateMeltOperationRequest,
  type CreateMintQuoteRequest,
  type CreateMeltQuoteRequest,
  type CreateReceiveOperationRequest,
  type CreateSendOperationRequest,
  type EvaluatePaymentRequestRequest,
  type ExecuteSendOperationResponseDocument,
  type ExecuteMeltOperationResponseDocument,
  type HealthDocument,
  type HistoryDocument,
  type HistoryPageDocument,
  type InitializeWalletRequest,
  type InitializeWalletResponseDocument,
  type KnownMintDocument,
  type KnownMintsDocument,
  type LifecycleStatusDocument,
  type MintInformationDocument,
  type MintOperationDocument,
  type MintOperationsDocument,
  type MeltOperationDocument,
  type MeltOperationsDocument,
  type MeltResultDocument,
  type MintQuoteDocument,
  type MeltQuoteDocument,
  type MintUrlRequest,
  type PaymentMethodCapabilitiesDocument,
  type PaymentRequestEvaluationDocument,
  type PendingMintQuotesDocument,
  type PendingMeltQuotesDocument,
  type ProcessShutdownRequest,
  type ProcessShutdownResponseDocument,
  type ResourceInvalidationEventDocument,
  type ReceiveOperationDocument,
  type ReceiveOperationsDocument,
  type SendOperationDocument,
  type SendOperationsDocument,
  type SendResultDocument,
  type StartSessionRequest,
  type StopSessionRequest,
  type WalletRecoveryMaterialRequest,
  type WalletRecoveryMaterialResponseDocument,
} from './schema.js';

export * from './contract.js';
export { buildV1FallbackHandler, buildV1Routes } from './runner.js';
export * from './schema.js';

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

const pathParameter = (name: string): V1RouteParameter => ({
  name,
  in: 'path',
  required: true,
  schema: { type: 'string', minLength: 1 },
});

const OFFSET_PARAMETER = {
  name: 'offset',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 0, default: 0 },
} as const satisfies V1RouteParameter;

const LIMIT_PARAMETER = {
  name: 'limit',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, maximum: MAX_PAGE_LIMIT, default: DEFAULT_PAGE_LIMIT },
} as const satisfies V1RouteParameter;

const PAGE_PARAMETERS = [OFFSET_PARAMETER, LIMIT_PARAMETER] as const;
const MINT_URL_QUERY_PARAMETER = {
  name: 'mintUrl',
  in: 'query',
  required: true,
  schema: { type: 'string', format: 'uri', pattern: '^https?://' },
} as const satisfies V1RouteParameter;
const TRUSTED_ONLY_QUERY_PARAMETER = {
  name: 'trustedOnly',
  in: 'query',
  required: false,
  schema: { type: 'boolean' },
} as const satisfies V1RouteParameter;
const QUOTE_METHOD_QUERY_PARAMETER = {
  name: 'method',
  in: 'query',
  required: false,
  schema: { type: 'string', enum: ['bolt11', 'bolt12', 'onchain'] },
} as const satisfies V1RouteParameter;
const BALANCE_PARAMETERS = [
  {
    name: 'mintUrl',
    in: 'query',
    required: false,
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      items: { type: 'string', format: 'uri', pattern: '^https?://' },
    },
  },
  {
    name: 'unit',
    in: 'query',
    required: false,
    style: 'form',
    explode: true,
    schema: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  TRUSTED_ONLY_QUERY_PARAMETER,
] as const satisfies readonly V1RouteParameter[];

const HEALTH_ROUTE = {
  method: 'GET',
  path: '/health',
  capability: null,
  requestSchema: noBodySchema,
  responseSchema: healthSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<null, HealthDocument>;

const OPENAPI_ROUTE = {
  method: 'GET',
  path: '/v1/openapi.json',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: openApiDocumentSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<null, unknown>;

const EVALUATE_PAYMENT_REQUEST_ROUTE = {
  method: 'POST',
  path: '/v1/payment-requests/evaluate',
  capability: 'wallet:read',
  requestSchema: evaluatePaymentRequestRequestSchema,
  responseSchema: paymentRequestEvaluationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<
  EvaluatePaymentRequestRequest,
  PaymentRequestEvaluationDocument
>;

const STATUS_ROUTE = {
  method: 'GET',
  path: '/v1/status',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: lifecycleStatusSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<null, LifecycleStatusDocument>;

const BALANCES_ROUTE = {
  method: 'GET',
  path: '/v1/balances',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: balancesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: BALANCE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, BalancesDocument>;

const LIST_HISTORY_ROUTE = {
  method: 'GET',
  path: '/v1/history',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: historyPageSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, HistoryPageDocument>;

const GET_HISTORY_ROUTE = {
  method: 'GET',
  path: '/v1/history/{historyEntryId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: historySchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('historyEntryId')],
} as const satisfies V1RouteMetadata<null, HistoryDocument>;

const EVENTS_ROUTE = {
  method: 'GET',
  path: '/v1/events',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: resourceInvalidationEventSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  responseMediaType: 'text/event-stream',
} as const satisfies V1RouteMetadata<null, ResourceInvalidationEventDocument>;

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

const CREATE_MINT_QUOTE_ROUTE = {
  method: 'POST',
  path: '/v1/quotes/mint',
  capability: 'wallet:admin',
  requestSchema: createMintQuoteRequestSchema,
  responseSchema: mintQuoteSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateMintQuoteRequest, MintQuoteDocument>;

const GET_MINT_QUOTE_ROUTE = {
  method: 'GET',
  path: '/v1/quotes/mint/{quoteId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintQuoteSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, MintQuoteDocument>;

const LIST_PENDING_MINT_QUOTES_ROUTE = {
  method: 'GET',
  path: '/v1/quotes/mint/pending',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: pendingMintQuotesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [QUOTE_METHOD_QUERY_PARAMETER, ...PAGE_PARAMETERS],
} as const satisfies V1RouteMetadata<null, PendingMintQuotesDocument>;

const REFRESH_MINT_QUOTE_ROUTE = {
  method: 'POST',
  path: '/v1/quotes/mint/{quoteId}/refresh',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: mintQuoteSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, MintQuoteDocument>;

const CREATE_MELT_QUOTE_ROUTE = {
  method: 'POST',
  path: '/v1/quotes/melt',
  capability: 'wallet:admin',
  requestSchema: createMeltQuoteRequestSchema,
  responseSchema: meltQuoteSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateMeltQuoteRequest, MeltQuoteDocument>;

const GET_MELT_QUOTE_ROUTE = {
  method: 'GET',
  path: '/v1/quotes/melt/{quoteId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltQuoteSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, MeltQuoteDocument>;

const LIST_PENDING_MELT_QUOTES_ROUTE = {
  method: 'GET',
  path: '/v1/quotes/melt/pending',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: pendingMeltQuotesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [QUOTE_METHOD_QUERY_PARAMETER, ...PAGE_PARAMETERS],
} as const satisfies V1RouteMetadata<null, PendingMeltQuotesDocument>;

const REFRESH_MELT_QUOTE_ROUTE = {
  method: 'POST',
  path: '/v1/quotes/melt/{quoteId}/refresh',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: meltQuoteSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('quoteId'), MINT_URL_QUERY_PARAMETER],
} as const satisfies V1RouteMetadata<null, MeltQuoteDocument>;

const CREATE_MINT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/mint',
  capability: 'wallet:admin',
  requestSchema: createMintOperationRequestSchema,
  responseSchema: mintOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateMintOperationRequest, MintOperationDocument>;

const GET_MINT_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const LIST_PENDING_MINT_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/pending',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: mintOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, MintOperationsDocument>;

const LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE = {
  ...LIST_PENDING_MINT_OPERATIONS_ROUTE,
  path: '/v1/operations/mint/in-flight',
} as const satisfies V1RouteMetadata<null, MintOperationsDocument>;

const EXECUTE_MINT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/mint/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: mintOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const REFRESH_MINT_OPERATION_ROUTE = {
  ...EXECUTE_MINT_OPERATION_ROUTE,
  path: '/v1/operations/mint/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, MintOperationDocument>;

const GET_MINT_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/mint/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: noSuccessResponseSchema,
  successStatuses: [],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, never>;

const CREATE_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt',
  capability: 'wallet:admin',
  requestSchema: createMeltOperationRequestSchema,
  responseSchema: meltOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateMeltOperationRequest, MeltOperationDocument>;

const GET_MELT_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const LIST_PREPARED_MELT_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, MeltOperationsDocument>;

const LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_MELT_OPERATIONS_ROUTE,
  path: '/v1/operations/melt/in-flight',
} as const satisfies V1RouteMetadata<null, MeltOperationsDocument>;

const EXECUTE_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: executeMeltOperationResponseSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ExecuteMeltOperationResponseDocument>;

const GET_MELT_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/melt/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: meltResultSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltResultDocument>;

const CANCEL_MELT_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/melt/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: meltOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const REFRESH_MELT_OPERATION_ROUTE = {
  ...CANCEL_MELT_OPERATION_ROUTE,
  path: '/v1/operations/melt/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const RECLAIM_MELT_OPERATION_ROUTE = {
  ...CANCEL_MELT_OPERATION_ROUTE,
  path: '/v1/operations/melt/{operationId}/reclaim',
} as const satisfies V1RouteMetadata<null, MeltOperationDocument>;

const CREATE_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send',
  capability: 'wallet:admin',
  requestSchema: createSendOperationRequestSchema,
  responseSchema: sendOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateSendOperationRequest, SendOperationDocument>;

const GET_SEND_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const LIST_PREPARED_SEND_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, SendOperationsDocument>;

const LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_SEND_OPERATIONS_ROUTE,
  path: '/v1/operations/send/in-flight',
} as const satisfies V1RouteMetadata<null, SendOperationsDocument>;

const EXECUTE_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: executeSendOperationResponseSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ExecuteSendOperationResponseDocument>;

const GET_SEND_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/send/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: sendResultSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendResultDocument>;

const CANCEL_SEND_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/send/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: sendOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const REFRESH_SEND_OPERATION_ROUTE = {
  ...CANCEL_SEND_OPERATION_ROUTE,
  path: '/v1/operations/send/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const RECLAIM_SEND_OPERATION_ROUTE = {
  ...CANCEL_SEND_OPERATION_ROUTE,
  path: '/v1/operations/send/{operationId}/reclaim',
} as const satisfies V1RouteMetadata<null, SendOperationDocument>;

const CREATE_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive',
  capability: 'wallet:admin',
  requestSchema: createReceiveOperationRequestSchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [201],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<CreateReceiveOperationRequest, ReceiveOperationDocument>;

const GET_RECEIVE_OPERATION_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/{operationId}',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/prepared',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationsSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: PAGE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, ReceiveOperationsDocument>;

const LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE = {
  ...LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
  path: '/v1/operations/receive/in-flight',
} as const satisfies V1RouteMetadata<null, ReceiveOperationsDocument>;

const EXECUTE_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive/{operationId}/execute',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const GET_RECEIVE_OPERATION_RESULT_ROUTE = {
  method: 'GET',
  path: '/v1/operations/receive/{operationId}/result',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: noSuccessResponseSchema,
  successStatuses: [],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, never>;

const CANCEL_RECEIVE_OPERATION_ROUTE = {
  method: 'POST',
  path: '/v1/operations/receive/{operationId}/cancel',
  capability: 'wallet:admin',
  requestSchema: noBodySchema,
  responseSchema: receiveOperationSchema,
  successStatuses: [200],
  idempotencyKey: 'optional',
  responseCacheControl: null,
  parameters: [pathParameter('operationId')],
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const REFRESH_RECEIVE_OPERATION_ROUTE = {
  ...CANCEL_RECEIVE_OPERATION_ROUTE,
  path: '/v1/operations/receive/{operationId}/refresh',
} as const satisfies V1RouteMetadata<null, ReceiveOperationDocument>;

const INITIALIZE_WALLET_ROUTE = {
  method: 'POST',
  path: '/v1/admin/wallet/initialize',
  capability: 'wallet:admin',
  requestSchema: initializeWalletRequestSchema,
  responseSchema: initializeWalletResponseSchema,
  successStatuses: [201, 202],
  idempotencyKey: 'optional',
  responseCacheControl: 'no-store',
} as const satisfies V1RouteMetadata<InitializeWalletRequest, InitializeWalletResponseDocument>;

const WALLET_RECOVERY_MATERIAL_ROUTE = {
  method: 'POST',
  path: '/v1/admin/wallet/recovery-material',
  capability: 'wallet:admin',
  requestSchema: walletRecoveryMaterialRequestSchema,
  responseSchema: walletRecoveryMaterialResponseSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: 'no-store',
} as const satisfies V1RouteMetadata<
  WalletRecoveryMaterialRequest,
  WalletRecoveryMaterialResponseDocument
>;

const START_SESSION_ROUTE = {
  method: 'POST',
  path: '/v1/admin/session/start',
  capability: 'wallet:admin',
  requestSchema: startSessionRequestSchema,
  responseSchema: lifecycleStatusSchema,
  successStatuses: [200, 202],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<StartSessionRequest, LifecycleStatusDocument>;

const STOP_SESSION_ROUTE = {
  method: 'POST',
  path: '/v1/admin/session/stop',
  capability: 'wallet:admin',
  requestSchema: stopSessionRequestSchema,
  responseSchema: lifecycleStatusSchema,
  successStatuses: [200, 202],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<StopSessionRequest, LifecycleStatusDocument>;

const STOP_PROCESS_ROUTE = {
  method: 'POST',
  path: '/v1/admin/process/stop',
  capability: 'wallet:admin',
  requestSchema: processShutdownRequestSchema,
  responseSchema: processShutdownResponseSchema,
  successStatuses: [202],
  idempotencyKey: 'optional',
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<ProcessShutdownRequest, ProcessShutdownResponseDocument>;

/** Returns implemented v1 route metadata without constructing a runtime or executable handlers. */
export function createV1RouteMetadata(): Array<V1RouteMetadata> {
  return [
    HEALTH_ROUTE,
    OPENAPI_ROUTE,
    STATUS_ROUTE,
    EVALUATE_PAYMENT_REQUEST_ROUTE,
    BALANCES_ROUTE,
    LIST_HISTORY_ROUTE,
    GET_HISTORY_ROUTE,
    EVENTS_ROUTE,
    LIST_MINTS_ROUTE,
    CREATE_MINT_ROUTE,
    TRUST_MINT_ROUTE,
    UNTRUST_MINT_ROUTE,
    MINT_INFO_ROUTE,
    PAYMENT_METHOD_CAPABILITIES_ROUTE,
    CREATE_MINT_QUOTE_ROUTE,
    LIST_PENDING_MINT_QUOTES_ROUTE,
    GET_MINT_QUOTE_ROUTE,
    REFRESH_MINT_QUOTE_ROUTE,
    CREATE_MELT_QUOTE_ROUTE,
    LIST_PENDING_MELT_QUOTES_ROUTE,
    GET_MELT_QUOTE_ROUTE,
    REFRESH_MELT_QUOTE_ROUTE,
    CREATE_MINT_OPERATION_ROUTE,
    LIST_PENDING_MINT_OPERATIONS_ROUTE,
    LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
    GET_MINT_OPERATION_ROUTE,
    EXECUTE_MINT_OPERATION_ROUTE,
    GET_MINT_OPERATION_RESULT_ROUTE,
    REFRESH_MINT_OPERATION_ROUTE,
    CREATE_MELT_OPERATION_ROUTE,
    LIST_PREPARED_MELT_OPERATIONS_ROUTE,
    LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
    GET_MELT_OPERATION_ROUTE,
    EXECUTE_MELT_OPERATION_ROUTE,
    GET_MELT_OPERATION_RESULT_ROUTE,
    CANCEL_MELT_OPERATION_ROUTE,
    REFRESH_MELT_OPERATION_ROUTE,
    RECLAIM_MELT_OPERATION_ROUTE,
    CREATE_SEND_OPERATION_ROUTE,
    LIST_PREPARED_SEND_OPERATIONS_ROUTE,
    LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
    GET_SEND_OPERATION_ROUTE,
    EXECUTE_SEND_OPERATION_ROUTE,
    GET_SEND_OPERATION_RESULT_ROUTE,
    CANCEL_SEND_OPERATION_ROUTE,
    REFRESH_SEND_OPERATION_ROUTE,
    RECLAIM_SEND_OPERATION_ROUTE,
    CREATE_RECEIVE_OPERATION_ROUTE,
    LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
    LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
    GET_RECEIVE_OPERATION_ROUTE,
    EXECUTE_RECEIVE_OPERATION_ROUTE,
    GET_RECEIVE_OPERATION_RESULT_ROUTE,
    CANCEL_RECEIVE_OPERATION_ROUTE,
    REFRESH_RECEIVE_OPERATION_ROUTE,
    INITIALIZE_WALLET_ROUTE,
    WALLET_RECOVERY_MATERIAL_ROUTE,
    START_SESSION_ROUTE,
    STOP_SESSION_ROUTE,
    STOP_PROCESS_ROUTE,
  ];
}

/** Binds the transport-independent Cocod runtime to the implemented v1 route metadata. */
export function createV1RouteDefinitions(
  runtime: V1Runtime,
  daemonVersion: string,
  processShutdown: Pick<ProcessShutdownCoordinator, 'request'>,
  logger?: AppLogger,
): Array<V1RouteDefinition> {
  const health = defineV1Route({
    ...HEALTH_ROUTE,
    handler: () => ({ status: 'ok', interfaceVersion: '1' }),
  });
  const openApi = defineV1Route({
    ...OPENAPI_ROUTE,
    handler: () => generateV1OpenApiDocument(createV1RouteMetadata(), daemonVersion),
  });
  const evaluatePaymentRequest = defineV1Route({
    ...EVALUATE_PAYMENT_REQUEST_ROUTE,
    handler: async (input) => {
      const paymentRequests = requireRunningSession(runtime).manager.paymentRequests;
      try {
        return toPaymentRequestEvaluationDocument(await paymentRequests.parse(input.request));
      } catch (error) {
        throw paymentRequestCocoError('evaluate the Payment Request', error);
      }
    },
  });
  const status = defineV1Route({
    ...STATUS_ROUTE,
    handler: () => toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
  });
  const balances = defineV1Route({
    ...BALANCES_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const scope = parseBalanceScope(request);

      try {
        const byMintAndUnit = await session.manager.wallet.balances.byMintAndUnit(scope);
        return {
          items: Object.entries(byMintAndUnit).flatMap(([mintUrl, byUnit]) =>
            Object.entries(byUnit).map(([unit, balance]) => ({
              mintUrl,
              unit,
              spendable: balance.spendable.toString(),
              reserved: balance.reserved.toString(),
              total: balance.total.toString(),
            })),
          ),
        };
      } catch (error) {
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not return Wallet balances',
          retryable: false,
          cause: error,
        });
      }
    },
  });
  const listHistory = defineV1Route({
    ...LIST_HISTORY_ROUTE,
    handler: async (_input, request) => {
      const history = requireRunningSession(runtime).manager.history;
      const { offset, limit } = parseHistoryPageQuery(request);
      try {
        const entries = await history.getPaginatedHistory(offset, limit);
        return { items: entries.map(toHistoryDocument), offset, limit };
      } catch (error) {
        throw historyCocoError('list Wallet history', error);
      }
    },
  });
  const getHistory = defineV1Route({
    ...GET_HISTORY_ROUTE,
    handler: async (_input, request) => {
      const history = requireRunningSession(runtime).manager.history;
      const historyEntryId = parseHistoryEntryIdPath(request);
      try {
        const entry = await history.getHistoryEntryById(historyEntryId);
        if (!entry) throw historyNotFound();
        return toHistoryDocument(entry);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw historyCocoError('return the Wallet history entry', error);
      }
    },
  });
  const events = defineV1Route({
    ...EVENTS_ROUTE,
    handler: (_input, request) => {
      parseQuery(request, [], 'The Event stream query is invalid');
      const manager = requireRunningSession(runtime).manager;
      return new V1HttpStreamResponse(
        createResourceInvalidationStream(manager, request, logger),
        200,
        { Connection: 'keep-alive' },
      );
    },
  });
  const createMint = defineV1Route({
    ...CREATE_MINT_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');

      try {
        const { mint, created } = await session.manager.mint.addMint(mintUrl);
        return new V1HttpResponse(toKnownMintDocument(mint), created ? 201 : 200);
      } catch (error) {
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not register the Mint',
          retryable: false,
          cause: error,
        });
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
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not list Known Mints',
          retryable: false,
          cause: error,
        });
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
          throw new V1HttpError({
            status: 500,
            code: 'coco_error',
            message: `Coco could not ${trusted ? 'trust' : 'untrust'} the Mint`,
            retryable: false,
            cause: error,
          });
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
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not return Mint information',
          retryable: false,
          cause: error,
        });
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
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not return Payment Method Capabilities',
          retryable: false,
          cause: error,
        });
      }
    },
  });
  const createMintQuote = defineV1Route({
    ...CREATE_MINT_QUOTE_ROUTE,
    handler: async (input) => {
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
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not create the Mint Quote',
          retryable: false,
          cause: error,
        });
      }
    },
  });
  const mintQuoteRoutes = createQuoteReadRouteDefinitions({
    runtime,
    type: 'mint',
    label: 'Mint',
    listRoute: LIST_PENDING_MINT_QUOTES_ROUTE,
    getRoute: GET_MINT_QUOTE_ROUTE,
    refreshRoute: REFRESH_MINT_QUOTE_ROUTE,
    getAdapter: (session) => session.manager.quotes.mint,
    toDocument: toMintQuoteDocument,
  });
  const createMeltQuote = defineV1Route({
    ...CREATE_MELT_QUOTE_ROUTE,
    handler: async (input) => {
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
        throw new V1HttpError({
          status: 500,
          code: 'coco_error',
          message: 'Coco could not create the Melt Quote',
          retryable: false,
          cause: error,
        });
      }
    },
  });
  const meltQuoteRoutes = createQuoteReadRouteDefinitions({
    runtime,
    type: 'melt',
    label: 'Melt',
    listRoute: LIST_PENDING_MELT_QUOTES_ROUTE,
    getRoute: GET_MELT_QUOTE_ROUTE,
    refreshRoute: REFRESH_MELT_QUOTE_ROUTE,
    getAdapter: (session) => session.manager.quotes.melt,
    toDocument: toMeltQuoteDocument,
  });
  const createMintOperation = defineV1Route({
    ...CREATE_MINT_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const quote = await session.manager.quotes.mint.get({
          mintUrl,
          quoteId: input.quoteId,
        });
        if (!quote) throw quoteNotFound('Mint');
        const operation = await session.manager.ops.mint.prepare({
          quote,
          amount: input.amount,
        });
        return new V1HttpResponse(toMintOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw mintOperationCocoError('prepare the Mint Operation', error);
      }
    },
  });
  const getMintOperation = defineV1Route({
    ...GET_MINT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const mint = requireRunningSession(runtime).manager.ops.mint;
      const operationId = parseMintOperationId(request);
      try {
        const operation = await mint.get(operationId);
        if (!operation) throw mintOperationNotFound();
        return toMintOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw mintOperationCocoError('return the Mint Operation', error);
      }
    },
  });
  const listMintOperations = (
    route: typeof LIST_PENDING_MINT_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
    kind: 'pending' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const mint = requireRunningSession(runtime).manager.ops.mint;
        const { offset, limit } = parseMintOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'pending' ? await mint.listPending() : await mint.listInFlight();
          return {
            items: operations
              .toSorted(compareMintOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toMintOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw mintOperationCocoError(`list ${kind} Mint Operations`, error);
        }
      },
    });
  const listPendingMintOperations = listMintOperations(
    LIST_PENDING_MINT_OPERATIONS_ROUTE,
    'pending',
  );
  const listInFlightMintOperations = listMintOperations(
    LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE,
    'in-flight',
  );
  const mintOperationCommand = (
    route: typeof EXECUTE_MINT_OPERATION_ROUTE | typeof REFRESH_MINT_OPERATION_ROUTE,
    command: 'execute' | 'refresh',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const mint = requireRunningSession(runtime).manager.ops.mint;
        const operationId = parseMintOperationId(request, command);
        try {
          return toMintOperationDocument(await mint[command](operationId));
        } catch (error) {
          throw mintOperationCocoError(`${command} the Mint Operation`, error);
        }
      },
    });
  const executeMintOperation = mintOperationCommand(EXECUTE_MINT_OPERATION_ROUTE, 'execute');
  const refreshMintOperation = mintOperationCommand(REFRESH_MINT_OPERATION_ROUTE, 'refresh');
  const getMintOperationResult = defineV1Route({
    ...GET_MINT_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      requireRunningSession(runtime);
      parseMintOperationId(request, 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Mint Operations do not expose a distinct result',
        retryable: false,
      });
    },
  });
  const createMeltOperation = defineV1Route({
    ...CREATE_MELT_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const quote = await session.manager.quotes.melt.get({
          mintUrl,
          quoteId: input.quoteId,
        });
        if (!quote) throw quoteNotFound('Melt');
        if (quote.method === 'onchain' && input.feeIndex === undefined) {
          throw new V1HttpError({
            status: 400,
            code: 'invalid_request',
            message: 'feeIndex is required for an on-chain Melt Quote',
            retryable: false,
          });
        }
        const operation = await session.manager.ops.melt.prepare({
          quote,
          ...(input.feeIndex !== undefined ? { feeIndex: input.feeIndex } : {}),
        } as Parameters<typeof session.manager.ops.melt.prepare>[0]);
        return new V1HttpResponse(toMeltOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('prepare the Melt Operation', error);
      }
    },
  });
  const getMeltOperation = defineV1Route({
    ...GET_MELT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request);
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw meltOperationNotFound();
        return toMeltOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('return the Melt Operation', error);
      }
    },
  });
  const listMeltOperations = (
    route: typeof LIST_PREPARED_MELT_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const melt = requireRunningSession(runtime).manager.ops.melt;
        const { offset, limit } = parseMeltOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await melt.listPrepared() : await melt.listInFlight();
          return {
            items: operations
              .toSorted(compareMeltOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toMeltOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw meltOperationCocoError(`list ${kind} Melt Operations`, error);
        }
      },
    });
  const listPreparedMeltOperations = listMeltOperations(
    LIST_PREPARED_MELT_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightMeltOperations = listMeltOperations(
    LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeMeltOperation = defineV1Route({
    ...EXECUTE_MELT_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request, 'execute');
      try {
        const operation = await melt.execute(operationId);
        const result = toMeltResultDocument(operation);
        return {
          operation: toMeltOperationDocument(operation),
          ...(result ? { result } : {}),
        };
      } catch (error) {
        throw meltOperationCocoError('execute the Melt Operation', error);
      }
    },
  });
  const getMeltOperationResult = defineV1Route({
    ...GET_MELT_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      const melt = requireRunningSession(runtime).manager.ops.melt;
      const operationId = parseMeltOperationId(request, 'result');
      try {
        const operation = await melt.get(operationId);
        if (!operation) throw meltOperationNotFound();
        const result = toMeltResultDocument(operation);
        if (!result) {
          throw new V1HttpError({
            status: 409,
            code: 'operation_result_not_available',
            message: 'The Melt Operation result is not available',
            retryable: operation.state === 'executing' || operation.state === 'pending',
            details: { state: operation.state },
          });
        }
        return result;
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw meltOperationCocoError('return the Melt Operation result', error);
      }
    },
  });
  const meltOperationCommand = (
    route:
      | typeof CANCEL_MELT_OPERATION_ROUTE
      | typeof REFRESH_MELT_OPERATION_ROUTE
      | typeof RECLAIM_MELT_OPERATION_ROUTE,
    command: 'cancel' | 'refresh' | 'reclaim',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const melt = requireRunningSession(runtime).manager.ops.melt;
        const operationId = parseMeltOperationId(request, command);
        try {
          await melt[command](operationId);
          const operation = await melt.get(operationId);
          if (!operation) throw meltOperationNotFound();
          return toMeltOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw meltOperationCocoError(`${command} the Melt Operation`, error);
        }
      },
    });
  const cancelMeltOperation = meltOperationCommand(CANCEL_MELT_OPERATION_ROUTE, 'cancel');
  const refreshMeltOperation = meltOperationCommand(REFRESH_MELT_OPERATION_ROUTE, 'refresh');
  const reclaimMeltOperation = meltOperationCommand(RECLAIM_MELT_OPERATION_ROUTE, 'reclaim');
  const createSendOperation = defineV1Route({
    ...CREATE_SEND_OPERATION_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl =
        input.mintUrl === undefined
          ? session.mintUrl
          : parseMintUrl(input.mintUrl, 'The Mint URL is invalid');
      try {
        const operation =
          'source' in input
            ? await preparePaymentRequestSend(session, input, mintUrl)
            : await session.manager.ops.send.prepare({
                mintUrl,
                amount: input.amount,
                unit: input.unit,
                ...(input.forceSwap !== undefined ? { forceSwap: input.forceSwap } : {}),
              });
        return new V1HttpResponse(toSendOperationDocument(operation), 201);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        if ('source' in input) {
          throw paymentRequestCocoError('prepare the Payment Request', error);
        }
        throw sendOperationCocoError('prepare the Send Operation', error);
      }
    },
  });
  const getSendOperation = defineV1Route({
    ...GET_SEND_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request);
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw sendOperationNotFound();
        return toSendOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError('return the Send Operation', error);
      }
    },
  });
  const listSendOperations = (
    route: typeof LIST_PREPARED_SEND_OPERATIONS_ROUTE | typeof LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const send = requireRunningSession(runtime).manager.ops.send;
        const { offset, limit } = parseSendOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await send.listPrepared() : await send.listInFlight();
          return {
            items: operations
              .toSorted(compareSendOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toSendOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw sendOperationCocoError(`list ${kind} Send Operations`, error);
        }
      },
    });
  const listPreparedSendOperations = listSendOperations(
    LIST_PREPARED_SEND_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightSendOperations = listSendOperations(
    LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeSendOperation = defineV1Route({
    ...EXECUTE_SEND_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request, 'execute');
      try {
        const { operation, token } = await session.manager.ops.send.execute(operationId);
        return {
          operation: toSendOperationDocument(operation),
          result: { token: session.manager.wallet.encodeToken(token) },
        };
      } catch (error) {
        throw sendOperationCocoError('execute the Send Operation', error);
      }
    },
  });
  const getSendOperationResult = defineV1Route({
    ...GET_SEND_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      const session = requireRunningSession(runtime);
      const operationId = parseSendOperationId(request, 'result');
      try {
        const operation = await session.manager.ops.send.get(operationId);
        if (!operation) throw sendOperationNotFound();
        if (
          (operation.state !== 'pending' && operation.state !== 'finalized') ||
          !operation.token
        ) {
          throw new V1HttpError({
            status: 409,
            code: 'operation_result_not_available',
            message: 'The Send Operation result is not available',
            retryable: operation.state === 'executing',
            details: { state: operation.state },
          });
        }
        return { token: session.manager.wallet.encodeToken(operation.token) };
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw sendOperationCocoError('return the Send Operation result', error);
      }
    },
  });
  const sendOperationCommand = (
    route:
      | typeof CANCEL_SEND_OPERATION_ROUTE
      | typeof REFRESH_SEND_OPERATION_ROUTE
      | typeof RECLAIM_SEND_OPERATION_ROUTE,
    command: 'cancel' | 'refresh' | 'reclaim',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const send = requireRunningSession(runtime).manager.ops.send;
        const operationId = parseSendOperationId(request, command);
        try {
          await send[command](operationId);
          const operation = await send.get(operationId);
          if (!operation) throw sendOperationNotFound();
          return toSendOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw sendOperationCocoError(`${command} the Send Operation`, error);
        }
      },
    });
  const cancelSendOperation = sendOperationCommand(CANCEL_SEND_OPERATION_ROUTE, 'cancel');
  const refreshSendOperation = sendOperationCommand(REFRESH_SEND_OPERATION_ROUTE, 'refresh');
  const reclaimSendOperation = sendOperationCommand(RECLAIM_SEND_OPERATION_ROUTE, 'reclaim');
  const createReceiveOperation = defineV1Route({
    ...CREATE_RECEIVE_OPERATION_ROUTE,
    handler: async (input) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      try {
        const operation = await receive.prepare({ token: input.token });
        return new V1HttpResponse(toReceiveOperationDocument(operation), 201);
      } catch (error) {
        throw receiveOperationCocoError('prepare the Receive Operation', error);
      }
    },
  });
  const getReceiveOperation = defineV1Route({
    ...GET_RECEIVE_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseReceiveOperationId(request);
      try {
        const operation = await receive.get(operationId);
        if (!operation) throw receiveOperationNotFound();
        return toReceiveOperationDocument(operation);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw receiveOperationCocoError('return the Receive Operation', error);
      }
    },
  });
  const listReceiveOperations = (
    route:
      | typeof LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE
      | typeof LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
    kind: 'prepared' | 'in-flight',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const receive = requireRunningSession(runtime).manager.ops.receive;
        const { offset, limit } = parseReceiveOperationPageQuery(request, kind);
        try {
          const operations =
            kind === 'prepared' ? await receive.listPrepared() : await receive.listInFlight();
          return {
            items: operations
              .toSorted(compareReceiveOperationsForPagination)
              .slice(offset, offset + limit)
              .map(toReceiveOperationDocument),
            offset,
            limit,
          };
        } catch (error) {
          throw receiveOperationCocoError(`list ${kind} Receive Operations`, error);
        }
      },
    });
  const listPreparedReceiveOperations = listReceiveOperations(
    LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE,
    'prepared',
  );
  const listInFlightReceiveOperations = listReceiveOperations(
    LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE,
    'in-flight',
  );
  const executeReceiveOperation = defineV1Route({
    ...EXECUTE_RECEIVE_OPERATION_ROUTE,
    handler: async (_input, request) => {
      const receive = requireRunningSession(runtime).manager.ops.receive;
      const operationId = parseReceiveOperationId(request, 'execute');
      try {
        return toReceiveOperationDocument(await receive.execute(operationId));
      } catch (error) {
        throw receiveOperationCocoError('execute the Receive Operation', error);
      }
    },
  });
  const getReceiveOperationResult = defineV1Route({
    ...GET_RECEIVE_OPERATION_RESULT_ROUTE,
    handler: async (_input, request) => {
      requireRunningSession(runtime);
      parseReceiveOperationId(request, 'result');
      throw new V1HttpError({
        status: 404,
        code: 'not_found',
        message: 'Receive Operations do not expose a distinct result',
        retryable: false,
      });
    },
  });
  const receiveOperationCommand = (
    route: typeof CANCEL_RECEIVE_OPERATION_ROUTE | typeof REFRESH_RECEIVE_OPERATION_ROUTE,
    command: 'cancel' | 'refresh',
  ) =>
    defineV1Route({
      ...route,
      handler: async (_input, request) => {
        const receive = requireRunningSession(runtime).manager.ops.receive;
        const operationId = parseReceiveOperationId(request, command);
        try {
          await receive[command](operationId);
          const operation = await receive.get(operationId);
          if (!operation) throw receiveOperationNotFound();
          return toReceiveOperationDocument(operation);
        } catch (error) {
          if (error instanceof V1HttpError) throw error;
          throw receiveOperationCocoError(`${command} the Receive Operation`, error);
        }
      },
    });
  const cancelReceiveOperation = receiveOperationCommand(CANCEL_RECEIVE_OPERATION_ROUTE, 'cancel');
  const refreshReceiveOperation = receiveOperationCommand(
    REFRESH_RECEIVE_OPERATION_ROUTE,
    'refresh',
  );
  const initializeWallet = defineV1Route({
    ...INITIALIZE_WALLET_ROUTE,
    handler: async (input) => {
      const result = await runtime.initializeWallet(input);
      return new V1HttpResponse(
        {
          generatedMnemonic: result.mnemonic,
          status: toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
        },
        result.requiresPassphrase ? 201 : 202,
      );
    },
  });
  const walletRecoveryMaterial = defineV1Route({
    ...WALLET_RECOVERY_MATERIAL_ROUTE,
    handler: async (input) =>
      new V1HttpResponse({ mnemonic: await runtime.getWalletRecoveryMaterial(input) }),
  });
  const startSession = defineV1Route({
    ...START_SESSION_ROUTE,
    handler: async (input) => {
      const previousState = runtime.getStatus().cocoSession.state;
      const transition = runtime.startSession(input);
      await transition.accepted;
      observeDetachedTransition(transition.completion, 'session_start', logger);
      const result = toLifecycleStatusDocument(runtime.getStatus(), daemonVersion);
      return new V1HttpResponse(result, previousState === 'running' ? 200 : 202);
    },
  });
  const stopSession = defineV1Route({
    ...STOP_SESSION_ROUTE,
    handler: () => {
      const previousState = runtime.getStatus().cocoSession.state;
      const completion = runtime.stopSession();
      observeDetachedTransition(completion, 'session_stop', logger);
      const result = toLifecycleStatusDocument(runtime.getStatus(), daemonVersion);
      const alreadyStopped = previousState === 'stopped' && result.cocoSession.state === 'stopped';
      return new V1HttpResponse(result, alreadyStopped ? 200 : 202);
    },
  });
  const stopProcess = defineV1Route({
    ...STOP_PROCESS_ROUTE,
    handler: () => {
      void processShutdown.request('http_stop');
      return new V1HttpResponse({ status: 'stopping' }, 202);
    },
  });
  return [
    health,
    openApi,
    status,
    evaluatePaymentRequest,
    balances,
    listHistory,
    getHistory,
    events,
    listMints,
    createMint,
    trustMint,
    untrustMint,
    mintInfo,
    paymentMethodCapabilities,
    createMintQuote,
    ...mintQuoteRoutes,
    createMeltQuote,
    ...meltQuoteRoutes,
    createMintOperation,
    listPendingMintOperations,
    listInFlightMintOperations,
    getMintOperation,
    executeMintOperation,
    getMintOperationResult,
    refreshMintOperation,
    createMeltOperation,
    listPreparedMeltOperations,
    listInFlightMeltOperations,
    getMeltOperation,
    executeMeltOperation,
    getMeltOperationResult,
    cancelMeltOperation,
    refreshMeltOperation,
    reclaimMeltOperation,
    createSendOperation,
    listPreparedSendOperations,
    listInFlightSendOperations,
    getSendOperation,
    executeSendOperation,
    getSendOperationResult,
    cancelSendOperation,
    refreshSendOperation,
    reclaimSendOperation,
    createReceiveOperation,
    listPreparedReceiveOperations,
    listInFlightReceiveOperations,
    getReceiveOperation,
    executeReceiveOperation,
    getReceiveOperationResult,
    cancelReceiveOperation,
    refreshReceiveOperation,
    initializeWallet,
    walletRecoveryMaterial,
    startSession,
    stopSession,
    stopProcess,
  ];
}

function parseHistoryPageQuery(request: Request): { offset: number; limit: number } {
  const message = 'The Wallet history pagination is invalid';
  const query = parseQuery(request, queryParameterNames(LIST_HISTORY_ROUTE.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function parseHistoryEntryIdPath(request: Request): string {
  const message = 'The Wallet history entry identity is invalid';
  parseQuery(request, [], message);
  const id = parsePathIdentity(request, '/v1/history/', '', message);
  if (!parseHistoryEntryId(id)) throw invalidQuery(message);
  return id;
}

function toHistoryDocument(entry: HistoryEntry): HistoryDocument {
  const operationId = entry.operationId?.trim();
  const base = {
    id: entry.id,
    source: entry.source,
    ...(operationId ? { operationId } : {}),
    state: entry.state,
    mintUrl: normalizeMintUrl(entry.mintUrl),
    unit: entry.unit,
    amount: entry.amount.toString(),
    createdAt: new Date(entry.createdAt).toISOString(),
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };

  switch (entry.type) {
    case 'mint':
    case 'melt':
      return {
        ...base,
        type: entry.type,
        ...(entry.quoteId.trim() ? { quoteId: entry.quoteId } : {}),
      };
    case 'send':
      return { ...base, type: entry.type };
    case 'receive':
      return { ...base, type: entry.type };
  }
}

type CocoPublicEventSource = {
  on<E extends keyof CoreEvents>(
    event: E,
    handler: (payload: CoreEvents[E]) => void | Promise<void>,
  ): () => void;
};

const EVENT_KEEP_ALIVE_INTERVAL_MS = 5_000;

function createResourceInvalidationStream(
  manager: CocoPublicEventSource,
  request: Request,
  logger?: AppLogger,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanup = (_closeController: boolean) => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const unsubscribes: Array<() => void> = [];
      let keepAlive: ReturnType<typeof setInterval> | undefined;

      const enqueue = (document: ResourceInvalidationEventDocument): void => {
        if (closed) return;
        try {
          const event = resourceInvalidationEventSchema.parse(document);
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch (error) {
          logger?.error('event.projection_failed', {
            eventType: document.type,
            error: { name: error instanceof Error ? error.name : 'UnknownError' },
          });
        }
      };
      const invalidate = <E extends keyof CoreEvents>(
        event: E,
        project: (payload: CoreEvents[E]) => ResourceInvalidationEventDocument,
      ): void => {
        unsubscribes.push(
          manager.on(event, (payload) => {
            try {
              enqueue(project(payload));
            } catch (error) {
              logger?.error('event.projection_failed', {
                coreEvent: event,
                error: { name: error instanceof Error ? error.name : 'UnknownError' },
              });
            }
          }),
        );
      };
      const timestamp = (): string => new Date().toISOString();
      const mintUpdated = (mintUrl: string): ResourceInvalidationEventDocument => ({
        type: 'mint.updated',
        timestamp: timestamp(),
        data: { mintUrl: normalizeMintUrl(mintUrl) },
      });
      const balanceUpdated = (mintUrl: string): ResourceInvalidationEventDocument => ({
        type: 'balance.updated',
        timestamp: timestamp(),
        data: { mintUrl: normalizeMintUrl(mintUrl) },
      });
      const operationUpdated = (
        operationType: 'mint' | 'melt' | 'send' | 'receive',
        payload: { mintUrl: string; operationId: string },
      ): ResourceInvalidationEventDocument => ({
        type: 'operation.updated',
        timestamp: timestamp(),
        data: {
          operationType,
          operationId: payload.operationId,
          mintUrl: normalizeMintUrl(payload.mintUrl),
        },
      });

      invalidate('history:updated', ({ entry }) => ({
        type: 'history.updated',
        timestamp: timestamp(),
        data: toHistoryDocument(entry),
      }));

      invalidate('mint:added', ({ mint }) => mintUpdated(mint.mintUrl));
      invalidate('mint:updated', ({ mint }) => mintUpdated(mint.mintUrl));
      invalidate('mint:metadata-refreshed', ({ mintUrl }) => mintUpdated(mintUrl));
      invalidate('mint:trusted', ({ mintUrl }) => mintUpdated(mintUrl));
      invalidate('mint:untrusted', ({ mintUrl }) => mintUpdated(mintUrl));

      invalidate('mint-quote:updated', ({ mintUrl, method, quoteId }) => ({
        type: 'quote.updated',
        timestamp: timestamp(),
        data: { quoteType: 'mint', mintUrl: normalizeMintUrl(mintUrl), method, quoteId },
      }));
      invalidate('melt-quote:updated', ({ mintUrl, method, quoteId }) => ({
        type: 'quote.updated',
        timestamp: timestamp(),
        data: { quoteType: 'melt', mintUrl: normalizeMintUrl(mintUrl), method, quoteId },
      }));

      invalidate('send:prepared', (payload) => operationUpdated('send', payload));
      invalidate('send:pending', (payload) => operationUpdated('send', payload));
      invalidate('send:finalized', (payload) => operationUpdated('send', payload));
      invalidate('send:rolled-back', (payload) => operationUpdated('send', payload));
      invalidate('receive-op:prepared', (payload) => operationUpdated('receive', payload));
      invalidate('receive-op:finalized', (payload) => operationUpdated('receive', payload));
      invalidate('receive-op:rolled-back', (payload) => operationUpdated('receive', payload));
      invalidate('melt-op:prepared', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:pending', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:finalized', (payload) => operationUpdated('melt', payload));
      invalidate('melt-op:rolled-back', (payload) => operationUpdated('melt', payload));
      invalidate('mint-op:pending', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:requeue', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:executing', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:finalized', (payload) => operationUpdated('mint', payload));
      invalidate('mint-op:failed', (payload) => operationUpdated('mint', payload));

      invalidate('proofs:saved', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:state-changed', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:deleted', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:wiped', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:reserved', ({ mintUrl }) => balanceUpdated(mintUrl));
      invalidate('proofs:released', ({ mintUrl }) => balanceUpdated(mintUrl));

      const onAbort = () => cleanup(true);
      cleanup = (closeController: boolean): void => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        request.signal.removeEventListener('abort', onAbort);
        for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
        if (closeController) {
          try {
            controller.close();
          } catch {
            // The consumer may have cancelled the body at the same time as the request aborted.
          }
        }
      };

      controller.enqueue(encoder.encode(': connected\n\n'));
      keepAlive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': ping\n\n'));
      }, EVENT_KEEP_ALIVE_INTERVAL_MS);
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) cleanup(true);
    },
    cancel() {
      cleanup(false);
    },
  });
}

function historyCocoError(action: string, cause: unknown): V1HttpError {
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function historyNotFound(): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Wallet history entry does not exist',
    retryable: false,
  });
}

function toPaymentRequestEvaluationDocument(request: {
  amount?: { toString(): string };
  unit: string;
  transport: { type: 'inband' | 'http' | 'nostr' };
  allowedMints: string[];
  payableMints: string[];
  spendingCondition?:
    | { kind: 'P2PK' }
    | { kind: 'unsupported'; nut10Kind: string }
    | { kind: 'malformed'; nut10Kind: string };
}): PaymentRequestEvaluationDocument {
  const spendingCondition = request.spendingCondition;
  return {
    ...(request.amount !== undefined ? { amount: request.amount.toString() } : {}),
    unit: request.unit,
    transport: { type: request.transport.type },
    allowedMints: [...request.allowedMints],
    payableMints: [...request.payableMints],
    ...(spendingCondition !== undefined
      ? {
          spendingCondition:
            spendingCondition.kind === 'P2PK'
              ? { kind: spendingCondition.kind }
              : {
                  kind: spendingCondition.kind,
                  nut10Kind: spendingCondition.nut10Kind,
                },
        }
      : {}),
  };
}

type QuoteIdentityInput = { mintUrl: string; quoteId: string };
type BuiltInQuoteMethod = 'bolt11' | 'bolt12' | 'onchain';
type PaginatedQuote = { createdAt: number; mintUrl: string; quoteId: string; method: string };
type RunningSession = NonNullable<ReturnType<V1Runtime['getRunningSession']>>;

async function preparePaymentRequestSend(
  session: RunningSession,
  input: Extract<CreateSendOperationRequest, { source: unknown }>,
  mintUrl: string,
): Promise<SendOperation> {
  const resolved = await session.manager.paymentRequests.parse(input.source.request);
  if (resolved.transport.type !== 'inband') {
    throw new V1HttpError({
      status: 409,
      code: 'unsupported_behavior',
      message: 'Payment Request delivery is unsupported for this transport',
      retryable: false,
      details: { transport: resolved.transport.type },
    });
  }
  const amount =
    input.amount === undefined
      ? undefined
      : input.unit === undefined
        ? input.amount
        : { amount: input.amount, unit: input.unit };
  const prepared = await session.manager.paymentRequests.prepare(resolved, {
    mintUrl,
    ...(amount !== undefined ? { amount } : {}),
  });
  return prepared.sendOperation;
}

function paymentRequestCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof PaymentRequestError || cause instanceof UnitValidationError) {
    return new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'The Payment Request is invalid or cannot be paid',
      retryable: false,
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

interface QuoteReadAdapter<TQuote> {
  get(identity: QuoteIdentityInput): Promise<TQuote | null>;
  listPending(input?: { method?: BuiltInQuoteMethod }): Promise<TQuote[]>;
  refresh(identity: QuoteIdentityInput): Promise<TQuote>;
}

function createQuoteReadRouteDefinitions<TQuote extends PaginatedQuote, TDocument>(options: {
  runtime: V1Runtime;
  type: 'mint' | 'melt';
  label: 'Mint' | 'Melt';
  listRoute: V1RouteMetadata<null, { items: TDocument[]; offset: number; limit: number }>;
  getRoute: V1RouteMetadata<null, TDocument>;
  refreshRoute: V1RouteMetadata<null, TDocument>;
  getAdapter(session: RunningSession): QuoteReadAdapter<TQuote>;
  toDocument(quote: TQuote): TDocument;
}): Array<V1RouteDefinition> {
  const { runtime, type, label, getAdapter, toDocument } = options;
  const list = defineV1Route({
    ...options.listRoute,
    handler: async (_input, request) => {
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
        throw quoteCocoError(`list pending ${label} Quotes`, error);
      }
    },
  });
  const get = defineV1Route({
    ...options.getRoute,
    handler: async (_input, request) => {
      const adapter = getAdapter(requireRunningSession(runtime));
      const identity = parseQuoteIdentity(request, type, false);
      try {
        const quote = await adapter.get(identity);
        if (!quote) throw quoteNotFound(label);
        return toDocument(quote);
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw quoteCocoError(`return the ${label} Quote`, error);
      }
    },
  });
  const refresh = defineV1Route({
    ...options.refreshRoute,
    handler: async (_input, request) => {
      const adapter = getAdapter(requireRunningSession(runtime));
      const identity = parseQuoteIdentity(request, type, true);
      try {
        if (!(await adapter.get(identity))) throw quoteNotFound(label);
        return toDocument(await adapter.refresh(identity));
      } catch (error) {
        if (error instanceof V1HttpError) throw error;
        throw quoteCocoError(`reconcile the ${label} Quote`, error);
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

function quoteCocoError(action: string, cause: unknown): V1HttpError {
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function parseSingleMintUrlQuery(request: Request, message: string): string {
  const query = parseQuery(request, [MINT_URL_QUERY_PARAMETER.name], message);
  const values = query.getAll('mintUrl');
  if (values.length !== 1) {
    throw invalidQuery(message);
  }
  return parseMintUrl(values[0]!, message);
}

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

function parsePendingQuoteQuery(
  request: Request,
  type: 'mint' | 'melt',
): { method?: 'bolt11' | 'bolt12' | 'onchain'; offset: number; limit: number } {
  const message = `The pending ${type === 'mint' ? 'Mint' : 'Melt'} Quote filters are invalid`;
  const parameters =
    type === 'mint'
      ? LIST_PENDING_MINT_QUOTES_ROUTE.parameters
      : LIST_PENDING_MELT_QUOTES_ROUTE.parameters;
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

function parsePageInteger(
  values: string[],
  minimum: number,
  maximum: number,
  defaultValue: number,
  message: string,
): number {
  if (values.length === 0) return defaultValue;
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0]!)) throw invalidQuery(message);
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidQuery(message);
  }
  return value;
}

function parseMintUrl(value: string, message: string): string {
  try {
    if (value.length === 0) {
      throw new Error('Mint URL is empty');
    }
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Mint URL must use HTTP or HTTPS');
    }
    return normalizeMintUrl(value);
  } catch (error) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message,
      retryable: false,
      cause: error,
    });
  }
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

function toMintOperationDocument(operation: MintOperation): MintOperationDocument {
  const mintUrl = normalizeMintUrl(operation.mintUrl);
  return {
    id: operation.id,
    type: 'mint',
    state: operation.state,
    mintUrl,
    unit: operation.unit,
    method: operation.method,
    amount: operation.amount.toString(),
    quote: { mintUrl, quoteId: operation.quoteId },
    ...(operation.state !== 'init'
      ? {
          expiry:
            operation.expiry === null ? null : new Date(operation.expiry * 1_000).toISOString(),
        }
      : {}),
    ...(operation.terminalFailure
      ? {
          failure: {
            reason: 'The Mint Operation failed',
            ...(operation.terminalFailure.code !== undefined
              ? { code: operation.terminalFailure.code }
              : {}),
            ...(operation.terminalFailure.retryable !== undefined
              ? { retryable: operation.terminalFailure.retryable }
              : {}),
            observedAt: new Date(operation.terminalFailure.observedAt).toISOString(),
          },
        }
      : {}),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
}

function compareMintOperationsForPagination(left: MintOperation, right: MintOperation): number {
  return left.createdAt !== right.createdAt
    ? right.createdAt - left.createdAt
    : left.id.localeCompare(right.id);
}

function parseMintOperationPageQuery(
  request: Request,
  kind: 'pending' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Mint Operation filters are invalid`;
  const route =
    kind === 'pending' ? LIST_PENDING_MINT_OPERATIONS_ROUTE : LIST_IN_FLIGHT_MINT_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function mintOperationCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof MintOperationNotFoundError) return mintOperationNotFound(cause);
  if (cause instanceof OperationInProgressError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_in_progress',
      message: 'The Mint Operation is already in progress',
      retryable: true,
      details: { type: 'mint', operationId: cause.operationId },
      cause,
    });
  }
  if (cause instanceof MintOperationStateError) {
    return new V1HttpError({
      status: 409,
      code: 'invalid_operation_state',
      message: 'The Mint Operation command is unavailable in its current state',
      retryable: false,
      details: {
        type: 'mint',
        operationId: cause.operationId,
        state: cause.state,
        expectedStates: [...cause.expectedStates],
      },
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function mintOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Mint Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseMintOperationId(request: Request, command?: string): string {
  const message = 'The Mint Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/mint/', command ? `/${command}` : '', message);
}

function toMeltOperationDocument(operation: MeltOperation): MeltOperationDocument {
  const mintUrl = normalizeMintUrl(operation.mintUrl);
  const base = {
    id: operation.id,
    type: 'melt' as const,
    mintUrl,
    unit: operation.unit,
    method: operation.method,
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') {
    return {
      ...base,
      state: operation.state,
      ...(operation.quoteId ? { quote: { mintUrl, quoteId: operation.quoteId } } : {}),
    };
  }
  const methodData = operation.methodData as { feeIndex?: number };
  return {
    ...base,
    state: operation.state,
    amount: operation.amount.toString(),
    quote: { mintUrl, quoteId: operation.quoteId },
    feeReserve: operation.fee_reserve.toString(),
    swapFee: operation.swap_fee.toString(),
    inputAmount: operation.inputAmount.toString(),
    needsSwap: operation.needsSwap,
    ...(operation.method === 'onchain' && methodData.feeIndex !== undefined
      ? { feeIndex: methodData.feeIndex }
      : {}),
    ...(operation.state === 'finalized' && operation.changeAmount !== undefined
      ? { changeAmount: operation.changeAmount.toString() }
      : {}),
    ...(operation.state === 'finalized' && operation.effectiveFee !== undefined
      ? { effectiveFee: operation.effectiveFee.toString() }
      : {}),
  };
}

function meltOperationCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof MeltOperationNotFoundError) return meltOperationNotFound(cause);
  if (cause instanceof OperationInProgressError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_in_progress',
      message: 'The Melt Operation is already in progress',
      retryable: true,
      details: { type: 'melt', operationId: cause.operationId },
      cause,
    });
  }
  if (cause instanceof MeltOperationStateError) {
    return new V1HttpError({
      status: 409,
      code: 'invalid_operation_state',
      message: 'The Melt Operation command is unavailable in its current state',
      retryable: false,
      details: {
        type: 'melt',
        operationId: cause.operationId,
        state: cause.state,
        expectedStates: [...cause.expectedStates],
      },
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function toMeltResultDocument(operation: MeltOperation): MeltResultDocument | null {
  if (operation.state !== 'finalized' || !operation.finalizedData) return null;
  if (operation.method === 'onchain') {
    return operation.finalizedData.outpoint ? { outpoint: operation.finalizedData.outpoint } : null;
  }
  return operation.finalizedData.preimage ? { preimage: operation.finalizedData.preimage } : null;
}

function meltOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Melt Operation does not exist',
    retryable: false,
    cause,
  });
}

function compareMeltOperationsForPagination(left: MeltOperation, right: MeltOperation): number {
  return left.createdAt !== right.createdAt
    ? right.createdAt - left.createdAt
    : left.id.localeCompare(right.id);
}

function parseMeltOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Melt Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_MELT_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_MELT_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function parseMeltOperationId(request: Request, command?: string): string {
  const message = 'The Melt Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/melt/', command ? `/${command}` : '', message);
}

function toSendOperationDocument(operation: SendOperation): SendOperationDocument {
  const base = {
    id: operation.id,
    type: 'send' as const,
    mintUrl: normalizeMintUrl(operation.mintUrl),
    unit: operation.unit,
    method: operation.method,
    requestedAmount: operation.amount.toString(),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') return { ...base, state: operation.state };
  return {
    ...base,
    state: operation.state,
    inputAmount: operation.inputAmount.toString(),
    fee: operation.fee.toString(),
    needsSwap: operation.needsSwap,
  };
}

function compareSendOperationsForPagination(left: SendOperation, right: SendOperation): number {
  return left.createdAt !== right.createdAt
    ? right.createdAt - left.createdAt
    : left.id.localeCompare(right.id);
}

function parseSendOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Send Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_SEND_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_SEND_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function sendOperationCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof SendOperationNotFoundError) return sendOperationNotFound(cause);
  if (cause instanceof OperationInProgressError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_in_progress',
      message: 'The Send Operation is already in progress',
      retryable: true,
      details: { type: 'send', operationId: cause.operationId },
      cause,
    });
  }
  if (cause instanceof SendOperationStateError) {
    return new V1HttpError({
      status: 409,
      code: 'invalid_operation_state',
      message: 'The Send Operation command is unavailable in its current state',
      retryable: false,
      details: {
        type: 'send',
        operationId: cause.operationId,
        state: cause.state,
        expectedStates: [...cause.expectedStates],
      },
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function sendOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Send Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseSendOperationId(request: Request, command?: string): string {
  const message = 'The Send Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(request, '/v1/operations/send/', command ? `/${command}` : '', message);
}

function toReceiveOperationDocument(operation: ReceiveOperation): ReceiveOperationDocument {
  const base = {
    id: operation.id,
    type: 'receive' as const,
    mintUrl: normalizeMintUrl(operation.mintUrl),
    unit: operation.unit,
    amount: operation.amount.toString(),
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
  };
  if (operation.state === 'init') return { ...base, state: operation.state };
  return { ...base, state: operation.state, fee: operation.fee.toString() };
}

function compareReceiveOperationsForPagination(
  left: ReceiveOperation,
  right: ReceiveOperation,
): number {
  return left.createdAt !== right.createdAt
    ? right.createdAt - left.createdAt
    : left.id.localeCompare(right.id);
}

function parseReceiveOperationPageQuery(
  request: Request,
  kind: 'prepared' | 'in-flight',
): { offset: number; limit: number } {
  const message = `The ${kind} Receive Operation filters are invalid`;
  const route =
    kind === 'prepared'
      ? LIST_PREPARED_RECEIVE_OPERATIONS_ROUTE
      : LIST_IN_FLIGHT_RECEIVE_OPERATIONS_ROUTE;
  const query = parseQuery(request, queryParameterNames(route.parameters), message);
  return {
    offset: parsePageInteger(query.getAll('offset'), 0, Number.MAX_SAFE_INTEGER, 0, message),
    limit: parsePageInteger(query.getAll('limit'), 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT, message),
  };
}

function receiveOperationCocoError(action: string, cause: unknown): V1HttpError {
  if (cause instanceof ReceiveOperationNotFoundError) return receiveOperationNotFound(cause);
  if (cause instanceof OperationInProgressError) {
    return new V1HttpError({
      status: 409,
      code: 'operation_in_progress',
      message: 'The Receive Operation is already in progress',
      retryable: true,
      details: { type: 'receive', operationId: cause.operationId },
      cause,
    });
  }
  if (cause instanceof ReceiveOperationStateError) {
    return new V1HttpError({
      status: 409,
      code: 'invalid_operation_state',
      message: 'The Receive Operation command is unavailable in its current state',
      retryable: false,
      details: {
        type: 'receive',
        operationId: cause.operationId,
        state: cause.state,
        expectedStates: [...cause.expectedStates],
      },
      cause,
    });
  }
  return new V1HttpError({
    status: 500,
    code: 'coco_error',
    message: `Coco could not ${action}`,
    retryable: false,
    cause,
  });
}

function receiveOperationNotFound(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Receive Operation does not exist',
    retryable: false,
    cause,
  });
}

function parseReceiveOperationId(request: Request, command?: string): string {
  const message = 'The Receive Operation identity is invalid';
  parseQuery(request, [], message);
  return parsePathIdentity(
    request,
    '/v1/operations/receive/',
    command ? `/${command}` : '',
    message,
  );
}

function knownMintNotFound(): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: 'The Known Mint does not exist',
    retryable: false,
  });
}

function quoteNotFound(type: 'Mint' | 'Melt'): V1HttpError {
  return new V1HttpError({
    status: 404,
    code: 'not_found',
    message: `The ${type} Quote does not exist`,
    retryable: false,
  });
}

function parseQuoteIdPath(request: Request, type: 'mint' | 'melt', refresh: boolean): string {
  const prefix = `/v1/quotes/${type}/`;
  const suffix = refresh ? '/refresh' : '';
  const message = `The ${type === 'mint' ? 'Mint' : 'Melt'} Quote identity is invalid`;
  return parsePathIdentity(request, prefix, suffix, message);
}

function parsePathIdentity(
  request: Request,
  prefix: string,
  suffix: string,
  message: string,
): string {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) throw invalidQuery(message);
  const encoded = path.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
  try {
    const identity = decodeURIComponent(encoded);
    if (identity.length === 0 || identity.includes('/')) throw new Error('Invalid identity');
    return identity;
  } catch (error) {
    throw invalidQuery(message, error);
  }
}

function parseQuery(request: Request, allowedKeys: readonly string[], message: string) {
  const query = new URL(request.url).searchParams;
  const allowed = new Set(allowedKeys);
  if (Array.from(query.keys()).some((key) => !allowed.has(key))) {
    throw invalidQuery(message);
  }
  return query;
}

function queryParameterNames(parameters: readonly V1RouteParameter[]): string[] {
  return parameters
    .filter((parameter) => parameter.in === 'query')
    .map((parameter) => parameter.name);
}

function invalidQuery(message: string, cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message,
    retryable: false,
    cause,
  });
}

function requireRunningSession(runtime: V1Runtime) {
  const session = runtime.getRunningSession();
  if (session) {
    return session;
  }

  const status = runtime.getStatus();
  if (!status.wallet) {
    throw new V1HttpError({
      status: 409,
      code: 'wallet_not_configured',
      message: 'No Wallet is configured',
      retryable: false,
    });
  }
  if (status.cocoSession.state === 'starting' || status.cocoSession.state === 'stopping') {
    throw new V1HttpError({
      status: 503,
      code: 'session_transition_in_progress',
      message: `The Coco Session is ${status.cocoSession.state}`,
      retryable: true,
      details: { state: status.cocoSession.state },
      headers: { 'Retry-After': '1' },
    });
  }
  if (status.cocoSession.state === 'failed') {
    throw new V1HttpError({
      status: 503,
      code: 'session_restart_required',
      message: 'The Cocod Process must be restarted',
      retryable: false,
    });
  }
  if (status.seedAccess?.state === 'locked') {
    throw new V1HttpError({
      status: 423,
      code: 'wallet_locked',
      message: 'Wallet Seed Access is locked',
      retryable: false,
    });
  }
  throw new V1HttpError({
    status: 503,
    code: 'session_stopped',
    message: 'The Coco Session is stopped',
    retryable: true,
  });
}

function parseBalanceScope(request: Request): BalanceQuery {
  const query = parseQuery(
    request,
    queryParameterNames(BALANCES_ROUTE.parameters),
    'The balance filters are invalid',
  );

  const rawMintUrls = query.getAll('mintUrl');
  let mintUrls: string[];
  try {
    mintUrls = rawMintUrls.map((mintUrl) => {
      if (mintUrl.length === 0) {
        throw new Error('Mint URL is empty');
      }
      const parsed = new URL(mintUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Mint URL must use HTTP or HTTPS');
      }
      return normalizeMintUrl(mintUrl);
    });
  } catch (error) {
    throw invalidBalanceQuery(error);
  }

  const units = query.getAll('unit');
  if (units.some((unit) => unit.length === 0)) {
    throw invalidBalanceQuery();
  }

  const trustedOnlyValues = query.getAll('trustedOnly');
  if (
    trustedOnlyValues.length > 1 ||
    trustedOnlyValues.some((value) => value !== 'true' && value !== 'false')
  ) {
    throw invalidBalanceQuery();
  }

  return {
    ...(mintUrls.length > 0 ? { mintUrls } : {}),
    ...(units.length > 0 ? { units } : {}),
    ...(trustedOnlyValues.length === 1 ? { trustedOnly: trustedOnlyValues[0] === 'true' } : {}),
  };
}

function invalidBalanceQuery(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message: 'The balance filters are invalid',
    retryable: false,
    cause,
  });
}

function observeDetachedTransition(
  completion: Promise<void>,
  transition: 'session_start' | 'session_stop',
  logger?: AppLogger,
): void {
  void completion.catch((error) => {
    logger?.error('lifecycle.transition_failed', {
      transition,
      error: {
        name: error instanceof Error ? error.name : 'UnknownError',
        ...(error instanceof CocodRuntimeError ? { code: error.code } : {}),
      },
    });
  });
}
