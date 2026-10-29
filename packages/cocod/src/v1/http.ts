import { CocodRuntimeError } from '../runtime-error.js';
import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  V1HttpResponse,
  type V1RouteDefinition,
  type V1RouteMetadata,
  type V1Runtime,
} from './contract.js';
import { generateV1OpenApiDocument } from './openapi.js';
import { openApiDocumentSchema } from './resource-schemas.js';
import { balanceRoutes } from './resources/balances.js';
import { EVENT_KEEP_ALIVE_INTERVAL_MS, eventRoutes } from './resources/events.js';
import { historyRoutes } from './resources/history.js';
import { meltOperationRoutes } from './resources/melt-operations.js';
import { mintOperationRoutes } from './resources/mint-operations.js';
import { mintRoutes } from './resources/mints.js';
import { paymentRequestRoutes } from './resources/payment-requests.js';
import { quoteRoutes } from './resources/quotes.js';
import { receiveOperationRoutes } from './resources/receive-operations.js';
import { sendOperationRoutes } from './resources/send-operations.js';
import { defineResourceRoute, type ResourceRoute } from './resources/shared.js';
import {
  healthSchema,
  initializeWalletRequestSchema,
  initializeWalletResponseSchema,
  lifecycleStatusSchema,
  noBodySchema,
  processShutdownRequestSchema,
  processShutdownResponseSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  toLifecycleStatusDocument,
  walletRecoveryMaterialRequestSchema,
  walletRecoveryMaterialResponseSchema,
  type HealthDocument,
  type InitializeWalletRequest,
  type InitializeWalletResponseDocument,
  type LifecycleStatusDocument,
  type ProcessShutdownRequest,
  type ProcessShutdownResponseDocument,
  type StartSessionRequest,
  type StopSessionRequest,
  type WalletRecoveryMaterialRequest,
  type WalletRecoveryMaterialResponseDocument,
} from './schema.js';

export * from './contract.js';
export * from './resource-schemas.js';
export { buildV1FallbackHandler, buildV1Routes } from './runner.js';
export * from './schema.js';
export { generateV1OpenApiDocument, type V1OpenApiDocument } from './openapi.js';

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

const OPENAPI_ROUTE: ResourceRoute = defineResourceRoute({
  method: 'GET',
  path: '/v1/openapi.json',
  capability: 'wallet:read',
  summary: 'OpenAPI description of this interface',
  requestSchema: noBodySchema,
  responseSchema: openApiDocumentSchema,
  handler: (_input, _context, { daemonVersion }) =>
    generateV1OpenApiDocument(createV1RouteMetadata(), daemonVersion) as unknown as Record<
      string,
      unknown
    >,
});

/** Wallet resources served only while a Coco Session is running, in documentation order. */
const RESOURCE_ROUTES: readonly ResourceRoute[] = [
  OPENAPI_ROUTE,
  ...balanceRoutes,
  ...mintRoutes,
  ...quoteRoutes,
  ...mintOperationRoutes,
  ...meltOperationRoutes,
  ...sendOperationRoutes,
  ...receiveOperationRoutes,
  ...paymentRequestRoutes,
  ...historyRoutes,
  ...eventRoutes,
];

/** Options for binding route handlers to a Cocod Process. */
export interface V1RouteOptions {
  /** Event-stream keep-alive and credential re-check interval; defaults to five seconds. */
  eventKeepAliveIntervalMs?: number;
}

/** Returns all v1 route metadata without constructing a runtime or executable handlers. */
export function createV1RouteMetadata(): Array<V1RouteMetadata> {
  return [
    HEALTH_ROUTE,
    STATUS_ROUTE,
    INITIALIZE_WALLET_ROUTE,
    WALLET_RECOVERY_MATERIAL_ROUTE,
    START_SESSION_ROUTE,
    STOP_SESSION_ROUTE,
    STOP_PROCESS_ROUTE,
    ...RESOURCE_ROUTES.map((route) => route.metadata),
  ];
}

/** Binds the transport-independent Cocod runtime to every v1 route. */
export function createV1RouteDefinitions(
  runtime: V1Runtime,
  daemonVersion: string,
  processShutdown: Pick<ProcessShutdownCoordinator, 'request'>,
  logger?: AppLogger,
  options: V1RouteOptions = {},
): Array<V1RouteDefinition> {
  const resources = RESOURCE_ROUTES.map((route) =>
    route.bind({
      runtime,
      daemonVersion,
      logger,
      eventKeepAliveIntervalMs: options.eventKeepAliveIntervalMs ?? EVENT_KEEP_ALIVE_INTERVAL_MS,
    }),
  );
  const health = defineV1Route({
    ...HEALTH_ROUTE,
    handler: () => ({ status: 'ok', interfaceVersion: '1' }),
  });
  const status = defineV1Route({
    ...STATUS_ROUTE,
    handler: () => toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
  });
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
    status,
    initializeWallet,
    walletRecoveryMaterial,
    startSession,
    stopSession,
    stopProcess,
    ...resources,
  ];
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
