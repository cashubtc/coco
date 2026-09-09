import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  type V1RouteDefinition,
  type V1RouteHandlerContext,
  type V1Runtime,
} from './contract.js';

export interface CreateV1RouteDefinitionsOptions {
  eventAuthorizationRevalidationIntervalMs?: number;
}

/** Dependencies bound once by the HTTP composition root, read only when a request runs. */
export interface ResourceContext extends V1RouteHandlerContext, CreateV1RouteDefinitionsOptions {
  runtime: V1Runtime;
  daemonVersion: string;
  processShutdown: Pick<ProcessShutdownCoordinator, 'request'>;
  logger?: AppLogger;
}

export type ResourceRoute = V1RouteDefinition<unknown, unknown, ResourceContext>;

/** One route declaration supplies both its executable handler and its OpenAPI contract. */
export function defineResourceRoute<TRequest, TResponse>(
  route: V1RouteDefinition<TRequest, TResponse, ResourceContext>,
): ResourceRoute {
  return defineV1Route(route);
}
