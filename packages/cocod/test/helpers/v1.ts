import type { ProcessShutdownCoordinator } from '../../src/process-shutdown.js';
import type { AppLogger } from '../../src/utils/logger.js';
import {
  createV1RouteDefinitions,
  type V1LifecycleRuntime,
  type V1RouteDefinition,
} from '../../src/v1/http.js';

const unexpectedProcessShutdown: Pick<ProcessShutdownCoordinator, 'request'> = {
  request: () => {
    throw new Error('Unexpected Cocod Process shutdown');
  },
};

/** Binds lifecycle routes for tests that do not exercise Cocod Process shutdown. */
export function createLifecycleTestRouteDefinitions(
  runtime: V1LifecycleRuntime,
  daemonVersion: string,
  logger?: AppLogger,
): Array<V1RouteDefinition> {
  return createV1RouteDefinitions(runtime, daemonVersion, unexpectedProcessShutdown, logger);
}
