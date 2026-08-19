import { normalizeMintUrl, type BalanceQuery } from '@cashu/coco-core';

import { CocodRuntimeError } from '../runtime-error.js';
import type { ProcessShutdownCoordinator } from '../process-shutdown.js';
import type { AppLogger } from '../utils/logger.js';
import {
  defineV1Route,
  V1HttpError,
  V1HttpResponse,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from './contract.js';
import {
  balancesSchema,
  healthSchema,
  initializeWalletRequestSchema,
  initializeWalletResponseSchema,
  knownMintSchema,
  knownMintsSchema,
  lifecycleStatusSchema,
  mintInformationSchema,
  mintUrlRequestSchema,
  paymentMethodCapabilitiesSchema,
  noBodySchema,
  processShutdownRequestSchema,
  processShutdownResponseSchema,
  startSessionRequestSchema,
  stopSessionRequestSchema,
  toLifecycleStatusDocument,
  walletRecoveryMaterialRequestSchema,
  walletRecoveryMaterialResponseSchema,
  type BalancesDocument,
  type HealthDocument,
  type InitializeWalletRequest,
  type InitializeWalletResponseDocument,
  type KnownMintDocument,
  type KnownMintsDocument,
  type LifecycleStatusDocument,
  type MintInformationDocument,
  type MintUrlRequest,
  type PaymentMethodCapabilitiesDocument,
  type ProcessShutdownRequest,
  type ProcessShutdownResponseDocument,
  type StartSessionRequest,
  type StopSessionRequest,
  type WalletRecoveryMaterialRequest,
  type WalletRecoveryMaterialResponseDocument,
} from './schema.js';

export * from './contract.js';
export { buildV1FallbackHandler, buildV1Routes } from './runner.js';
export * from './schema.js';

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

const BALANCES_ROUTE = {
  method: 'GET',
  path: '/v1/balances',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: balancesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
} as const satisfies V1RouteMetadata<null, BalancesDocument>;

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
} as const satisfies V1RouteMetadata<null, PaymentMethodCapabilitiesDocument>;

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
    STATUS_ROUTE,
    BALANCES_ROUTE,
    LIST_MINTS_ROUTE,
    CREATE_MINT_ROUTE,
    TRUST_MINT_ROUTE,
    UNTRUST_MINT_ROUTE,
    MINT_INFO_ROUTE,
    PAYMENT_METHOD_CAPABILITIES_ROUTE,
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
  const createMint = defineV1Route({
    ...CREATE_MINT_ROUTE,
    handler: async (input) => {
      const session = requireRunningSession(runtime);
      const mintUrl = parseMintUrl(input.mintUrl, 'The Mint URL is invalid');

      try {
        const existing = (await session.manager.mint.getAllMints()).find(
          (mint) => normalizeMintUrl(mint.mintUrl) === mintUrl,
        );
        if (existing) {
          return new V1HttpResponse(toKnownMintDocument(existing), 200);
        }
        const { mint } = await session.manager.mint.addMint(mintUrl);
        return new V1HttpResponse(toKnownMintDocument(mint), 201, {
          Location: `/v1/mints/info?mintUrl=${encodeURIComponent(mint.mintUrl)}`,
        });
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
            throw new V1HttpError({
              status: 404,
              code: 'not_found',
              message: 'The Known Mint does not exist',
              retryable: false,
            });
          }
          if (trusted) {
            await session.manager.mint.trustMint(mintUrl);
          } else {
            await session.manager.mint.untrustMint(mintUrl);
          }
          const updated = await findKnownMint(session.manager.mint, mintUrl);
          return toKnownMintDocument(updated ?? { ...existing, trusted });
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
          throw new V1HttpError({
            status: 404,
            code: 'not_found',
            message: 'The Known Mint does not exist',
            retryable: false,
          });
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
      const input = parsePaymentMethodCapabilityQuery(request);
      try {
        if (!(await findKnownMint(session.manager.mint, input.mintUrl))) {
          throw new V1HttpError({
            status: 404,
            code: 'not_found',
            message: 'The Known Mint does not exist',
            retryable: false,
          });
        }
        const capabilities = await session.manager.mint.listPaymentMethodCapabilities(input);
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
    balances,
    listMints,
    createMint,
    trustMint,
    untrustMint,
    mintInfo,
    paymentMethodCapabilities,
    initializeWallet,
    walletRecoveryMaterial,
    startSession,
    stopSession,
    stopProcess,
  ];
}

function parsePaymentMethodCapabilityQuery(request: Request): {
  mintUrl: string;
  operation?: 'mint' | 'melt';
  unit?: string;
} {
  const query = new URL(request.url).searchParams;
  const allowedKeys = new Set(['mintUrl', 'operation', 'unit']);
  const mintUrls = query.getAll('mintUrl');
  const operations = query.getAll('operation');
  const units = query.getAll('unit');
  const invalid =
    Array.from(query.keys()).some((key) => !allowedKeys.has(key)) ||
    mintUrls.length !== 1 ||
    operations.length > 1 ||
    operations.some((value) => value !== 'mint' && value !== 'melt') ||
    units.length > 1 ||
    units.some((value) => value.length === 0);
  if (invalid) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message: 'The Payment Method Capability query is invalid',
      retryable: false,
    });
  }
  return {
    mintUrl: parseMintUrl(mintUrls[0]!, 'The Payment Method Capability query is invalid'),
    ...(operations.length === 1 ? { operation: operations[0] as 'mint' | 'melt' } : {}),
    ...(units.length === 1 ? { unit: units[0] } : {}),
  };
}

function parseSingleMintUrlQuery(request: Request, message: string): string {
  const query = new URL(request.url).searchParams;
  const values = query.getAll('mintUrl');
  if (Array.from(query.keys()).some((key) => key !== 'mintUrl') || values.length !== 1) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message,
      retryable: false,
    });
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
  mintApi: { getAllMints(): Promise<Array<{ mintUrl: string }>> },
  mintUrl: string,
) {
  return (await mintApi.getAllMints()).find(
    (mint) => normalizeMintUrl(mint.mintUrl) === mintUrl,
  ) as
    | {
        mintUrl: string;
        name: string;
        trusted: boolean;
        createdAt: number;
        updatedAt: number;
      }
    | undefined;
}

function parseTrustedOnly(request: Request, message: string): boolean {
  const query = new URL(request.url).searchParams;
  const allowedKeys = new Set(['trustedOnly']);
  const values = query.getAll('trustedOnly');
  if (
    Array.from(query.keys()).some((key) => !allowedKeys.has(key)) ||
    values.length > 1 ||
    values.some((value) => value !== 'true' && value !== 'false')
  ) {
    throw new V1HttpError({
      status: 400,
      code: 'invalid_request',
      message,
      retryable: false,
    });
  }
  return values[0] === 'true';
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

function toKnownMintDocument(mint: {
  mintUrl: string;
  name: string;
  trusted: boolean;
  createdAt: number;
  updatedAt: number;
}): KnownMintDocument {
  return {
    mintUrl: normalizeMintUrl(mint.mintUrl),
    name: mint.name,
    trusted: mint.trusted,
    createdAt: new Date(mint.createdAt * 1_000).toISOString(),
    updatedAt: new Date(mint.updatedAt * 1_000).toISOString(),
  };
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
  const query = new URL(request.url).searchParams;
  const allowedKeys = new Set(['mintUrl', 'unit', 'trustedOnly']);
  if (Array.from(query.keys()).some((key) => !allowedKeys.has(key))) {
    throw invalidBalanceQuery();
  }

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
