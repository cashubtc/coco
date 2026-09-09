import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from './contract.js';
import { generateV1OpenApiDocument } from './interface-description.js';
import { noBodySchema, openApiDocumentSchema } from './schema.js';

import {
  receiveOperationsMetadata,
  createReceiveOperationsRoutes,
} from './resources/receive-operations.js';
import { sendOperationsMetadata, createSendOperationsRoutes } from './resources/send-operations.js';
import { meltOperationsMetadata, createMeltOperationsRoutes } from './resources/melt-operations.js';
import { mintOperationsMetadata, createMintOperationsRoutes } from './resources/mint-operations.js';
import { quotesMetadata, createQuotesRoutes } from './resources/quotes.js';
import { mintsMetadata, createMintsRoutes } from './resources/mints.js';
import {
  eventsMetadata,
  createEventsRoutes,
  type CreateV1RouteDefinitionsOptions,
} from './resources/events.js';
import { historyMetadata, createHistoryRoutes } from './resources/history.js';
import { balancesMetadata, createBalancesRoutes } from './resources/balances.js';
import {
  paymentRequestsMetadata,
  createPaymentRequestsRoutes,
} from './resources/payment-requests.js';
import { lifecycleMetadata, createLifecycleRoutes } from './resources/lifecycle.js';
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

const httpMetadata = [OPENAPI_ROUTE];

function createHttpRoutes(daemonVersion: string): V1RouteDefinition[] {
  const openApi = defineV1Route({
    ...OPENAPI_ROUTE,
    handler: () => generateV1OpenApiDocument(createV1RouteMetadata(), daemonVersion),
  });
  return [openApi];
}

export function createV1RouteMetadata(): V1RouteMetadata[] {
  return [
    ...lifecycleMetadata,
    ...httpMetadata,
    ...paymentRequestsMetadata,
    ...balancesMetadata,
    ...historyMetadata,
    ...eventsMetadata,
    ...mintsMetadata,
    ...quotesMetadata,
    ...mintOperationsMetadata,
    ...meltOperationsMetadata,
    ...sendOperationsMetadata,
    ...receiveOperationsMetadata,
  ];
}

export function createV1RouteDefinitions(
  runtime: V1Runtime,
  daemonVersion: string,
  processShutdown: Pick<ProcessShutdownCoordinator, 'request'>,
  logger?: AppLogger,
  options: CreateV1RouteDefinitionsOptions = {},
): V1RouteDefinition[] {
  return [
    ...createLifecycleRoutes(runtime, daemonVersion, processShutdown, logger),
    ...createHttpRoutes(daemonVersion),
    ...createPaymentRequestsRoutes(runtime),
    ...createBalancesRoutes(runtime),
    ...createHistoryRoutes(runtime),
    ...createEventsRoutes(runtime, logger, options),
    ...createMintsRoutes(runtime),
    ...createQuotesRoutes(runtime),
    ...createMintOperationsRoutes(runtime),
    ...createMeltOperationsRoutes(runtime),
    ...createSendOperationsRoutes(runtime),
    ...createReceiveOperationsRoutes(runtime),
  ];
}
export type { CreateV1RouteDefinitionsOptions } from './resources/events.js';
export * from './contract.js';
export * from './schema.js';
export { buildV1FallbackHandler, buildV1Routes } from './runner.js';
