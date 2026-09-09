import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import type { V1RouteDefinition, V1RouteMetadata, V1Runtime } from './contract.js';
import { generateV1OpenApiDocument } from './interface-description.js';
import {
  defineResourceRoute,
  type CreateV1RouteDefinitionsOptions,
  type ResourceRoute,
} from './resource.js';
import { balancesRoutes } from './resources/balances.js';
import { eventsRoutes } from './resources/events.js';
import { historyRoutes } from './resources/history.js';
import { lifecycleRoutes } from './resources/lifecycle.js';
import { meltOperationsRoutes } from './resources/melt-operations.js';
import { mintOperationsRoutes } from './resources/mint-operations.js';
import { mintsRoutes } from './resources/mints.js';
import { paymentRequestsRoutes } from './resources/payment-requests.js';
import { quotesRoutes } from './resources/quotes.js';
import { receiveOperationsRoutes } from './resources/receive-operations.js';
import { sendOperationsRoutes } from './resources/send-operations.js';
import { noBodySchema, openApiDocumentSchema } from './schema.js';

const routes: ResourceRoute[] = [
  ...lifecycleRoutes,
  defineResourceRoute({
    method: 'GET',
    path: '/v1/openapi.json',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: openApiDocumentSchema,
    handler: (_input, _request, { daemonVersion }) =>
      generateV1OpenApiDocument(routes, daemonVersion),
  }),
  ...paymentRequestsRoutes,
  ...balancesRoutes,
  ...historyRoutes,
  ...eventsRoutes,
  ...mintsRoutes,
  ...quotesRoutes,
  ...mintOperationsRoutes,
  ...meltOperationsRoutes,
  ...sendOperationsRoutes,
  ...receiveOperationsRoutes,
];

export function createV1RouteMetadata(): V1RouteMetadata[] {
  return routes.map(({ handler, ...metadata }) => metadata);
}

export function createV1RouteDefinitions(
  runtime: V1Runtime,
  daemonVersion: string,
  processShutdown: Pick<ProcessShutdownCoordinator, 'request'>,
  logger?: AppLogger,
  options: CreateV1RouteDefinitionsOptions = {},
): V1RouteDefinition[] {
  return routes.map((route) => ({
    ...route,
    handler: (input, request, context) =>
      route.handler(input, request, {
        ...context,
        runtime,
        daemonVersion,
        processShutdown,
        logger,
        ...options,
      }),
  }));
}

export * from './contract.js';
export type { CreateV1RouteDefinitionsOptions } from './resource.js';
export { buildV1FallbackHandler, buildV1Routes } from './runner.js';
export * from './schema.js';
