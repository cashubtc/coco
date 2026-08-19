import type { ClientCapability } from '../credentials.js';
import type {
  CocodStatus,
  InitializeWalletInput,
  InitializeWalletResult,
  SessionStartTransition,
  WalletRecoveryMaterialInput,
} from '../runtime.js';
import type { RuntimeSchema, StartSessionRequest, V1ErrorCode } from './schema.js';

/** Headers supplied by a route-specific v1 response. */
export type ResponseHeaders = Headers | Record<string, string> | string[][];

type V1RouteHandler<TRequest, TResponse> = (
  input: TRequest,
  request: Request,
) => Promise<TResponse | V1HttpResponse<TResponse>> | TResponse | V1HttpResponse<TResponse>;

/** Declarative method, path, authorization, schema, and success contract for one v1 route. */
export interface V1RouteMetadata<TRequest = unknown, TResponse = unknown> {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly capability: ClientCapability | null;
  readonly requestSchema: RuntimeSchema<TRequest>;
  readonly responseSchema: RuntimeSchema<TResponse>;
  readonly successStatuses?: readonly number[];
  readonly idempotencyKey?: 'optional' | null;
  readonly responseCacheControl?: 'no-store' | null;
}

/** Executable v1 route definition formed by binding a handler to route metadata. */
export interface V1RouteDefinition<TRequest = unknown, TResponse = unknown> extends V1RouteMetadata<
  TRequest,
  TResponse
> {
  readonly handler: V1RouteHandler<TRequest, TResponse>;
}

/** Transport metadata for a stable v1 HTTP failure. */
export interface V1HttpErrorOptions {
  status: number;
  code: V1ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  headers?: ResponseHeaders;
  cause?: unknown;
}

/** Stable failure that the common v1 runner maps to an error document. */
export class V1HttpError extends Error {
  constructor(readonly options: V1HttpErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = 'V1HttpError';
  }
}

/** Carries route-specific HTTP metadata without exposing Response construction to handlers. */
export class V1HttpResponse<T> {
  constructor(
    readonly body: T,
    readonly status = 200,
    readonly headers?: ResponseHeaders,
  ) {}
}

/** Minimal transport-independent lifecycle interface consumed by the v1 route handlers. */
export interface V1LifecycleRuntime {
  getStatus(): CocodStatus;
  initializeWallet(input: InitializeWalletInput): Promise<InitializeWalletResult>;
  getWalletRecoveryMaterial(input?: WalletRecoveryMaterialInput): Promise<string>;
  startSession(input?: StartSessionRequest): SessionStartTransition;
  stopSession(): Promise<void>;
}

/** Preserves handler input/output types while erasing them for the common route runner. */
export function defineV1Route<TRequest, TResponse>(
  definition: V1RouteDefinition<TRequest, TResponse>,
): V1RouteDefinition {
  return {
    ...definition,
    successStatuses: definition.successStatuses ?? [200],
    idempotencyKey: definition.idempotencyKey ?? null,
    responseCacheControl: definition.responseCacheControl ?? null,
    handler: (input, request) => definition.handler(input as TRequest, request),
  };
}
