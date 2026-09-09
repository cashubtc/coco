import { CocodRuntimeError } from '../../runtime-error.js';
import type { AppLogger } from '../../utils/logger.js';
import { V1HttpResponse } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
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
} from '../schema.js';

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

export const lifecycleRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/health',
    capability: null,
    requestSchema: noBodySchema,
    responseSchema: healthSchema,
    handler: () => ({ status: 'ok', interfaceVersion: '1' }),
  }),
  defineResourceRoute({
    method: 'GET',
    path: '/v1/status',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: lifecycleStatusSchema,
    handler: (_input, _request, { runtime, daemonVersion }) =>
      toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/admin/wallet/initialize',
    capability: 'wallet:admin',
    requestSchema: initializeWalletRequestSchema,
    responseSchema: initializeWalletResponseSchema,
    successStatuses: [201, 202],
    idempotencyKey: 'optional',
    responseCacheControl: 'no-store',
    handler: async (input, _request, { runtime, daemonVersion }) => {
      const result = await runtime.initializeWallet(input);
      return new V1HttpResponse(
        {
          generatedMnemonic: result.mnemonic,
          status: toLifecycleStatusDocument(runtime.getStatus(), daemonVersion),
        },
        result.requiresPassphrase ? 201 : 202,
      );
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/admin/wallet/recovery-material',
    capability: 'wallet:admin',
    requestSchema: walletRecoveryMaterialRequestSchema,
    responseSchema: walletRecoveryMaterialResponseSchema,
    responseCacheControl: 'no-store',
    handler: async (input, _request, { runtime }) =>
      new V1HttpResponse({ mnemonic: await runtime.getWalletRecoveryMaterial(input) }),
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/admin/session/start',
    capability: 'wallet:admin',
    requestSchema: startSessionRequestSchema,
    responseSchema: lifecycleStatusSchema,
    successStatuses: [200, 202],
    idempotencyKey: 'optional',
    handler: async (input, _request, { runtime, daemonVersion, logger }) => {
      const previousState = runtime.getStatus().cocoSession.state;
      const transition = runtime.startSession(input);
      await transition.accepted;
      observeDetachedTransition(transition.completion, 'session_start', logger);
      const result = toLifecycleStatusDocument(runtime.getStatus(), daemonVersion);
      return new V1HttpResponse(result, previousState === 'running' ? 200 : 202);
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/admin/session/stop',
    capability: 'wallet:admin',
    requestSchema: stopSessionRequestSchema,
    responseSchema: lifecycleStatusSchema,
    successStatuses: [200, 202],
    idempotencyKey: 'optional',
    handler: (_input, _request, { runtime, daemonVersion, logger }) => {
      const previousState = runtime.getStatus().cocoSession.state;
      const completion = runtime.stopSession();
      observeDetachedTransition(completion, 'session_stop', logger);
      const result = toLifecycleStatusDocument(runtime.getStatus(), daemonVersion);
      const alreadyStopped = previousState === 'stopped' && result.cocoSession.state === 'stopped';
      return new V1HttpResponse(result, alreadyStopped ? 200 : 202);
    },
  }),
  defineResourceRoute({
    method: 'POST',
    path: '/v1/admin/process/stop',
    capability: 'wallet:admin',
    requestSchema: processShutdownRequestSchema,
    responseSchema: processShutdownResponseSchema,
    successStatuses: [202],
    idempotencyKey: 'optional',
    handler: (_input, _request, { processShutdown }) => {
      void processShutdown.request('http_stop');
      return new V1HttpResponse({ status: 'stopping' }, 202);
    },
  }),
];
