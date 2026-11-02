import type { ClientCapability } from '../credentials.js';
import type {
  CocodStatus,
  InitializeWalletInput,
  InitializeWalletResult,
  RunningCocoSession,
  SessionStartTransition,
  WalletRecoveryMaterialInput,
} from '../runtime.js';
import type { RuntimeSchema, StartSessionRequest, V1ErrorCode } from './schema.js';

/** Headers supplied by a route-specific v1 response. */
export type ResponseHeaders = Headers | Record<string, string> | string[][];

/**
 * One path or query parameter: its generated interface schema and the parser the runner applies.
 *
 * `parse` receives every raw value for the parameter: one decoded segment for a path parameter, and
 * all occurrences of a query parameter, which is empty when the client omitted it. It throws when
 * the values are invalid; the runner reports that as `invalid_request`.
 */
export interface V1Parameter<T> {
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly description?: string;
  /** Present for repeatable query parameters such as `?unit=sat&unit=usd`. */
  readonly explode?: true;
  parse(values: readonly string[]): T;
}

/** Parameters keyed by their wire name. */
export type V1Parameters = Readonly<Record<string, V1Parameter<unknown>>>;

/** Parsed values of a route's declared parameters. */
export type V1ParameterValues<P extends V1Parameters> = {
  [K in keyof P]: P[K] extends V1Parameter<infer T> ? T : never;
};

/** Per-request facts the common runner supplies to a route handler. */
export interface V1RequestContext<P extends V1Parameters = V1Parameters> {
  readonly request: Request;
  readonly params: V1ParameterValues<P>;
  /** Rechecks the request's original Client Credential against the active verifier. */
  reauthorize(): Promise<boolean>;
}

type V1HandlerResult<TResponse> = TResponse | V1HttpResponse<TResponse> | V1HttpStreamResponse;

type V1RouteHandler<TRequest, TResponse, P extends V1Parameters> = (
  input: TRequest,
  context: V1RequestContext<P>,
) => Promise<V1HandlerResult<TResponse>> | V1HandlerResult<TResponse>;

/** Declarative method, path, authorization, schema, and success contract for one v1 route. */
export interface V1RouteMetadata<
  TRequest = unknown,
  TResponse = unknown,
  P extends V1Parameters = V1Parameters,
> {
  readonly method: 'GET' | 'POST';
  /** OpenAPI path template; `{name}` segments must match declared path parameters. */
  readonly path: string;
  readonly capability: ClientCapability | null;
  readonly summary?: string;
  readonly requestSchema: RuntimeSchema<TRequest>;
  readonly responseSchema: RuntimeSchema<TResponse>;
  readonly successStatuses?: readonly number[];
  readonly idempotencyKey?: 'optional' | null;
  readonly responseCacheControl?: 'no-store' | null;
  /** Streaming routes return a `V1HttpStreamResponse`; `responseSchema` describes each event. */
  readonly responseMediaType?: 'application/json' | 'text/event-stream';
  readonly parameters?: P;
}

/** Executable v1 route definition formed by binding a handler to route metadata. */
export interface V1RouteDefinition<
  TRequest = unknown,
  TResponse = unknown,
  P extends V1Parameters = V1Parameters,
> extends V1RouteMetadata<TRequest, TResponse, P> {
  readonly handler: V1RouteHandler<TRequest, TResponse, P>;
  /**
   * Throws the lifecycle error that prevents this route from serving a request right now. The
   * runner calls it before an idempotent replay, which never reaches the handler's own check.
   */
  readonly assertAvailable?: () => void;
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

/** Carries an event stream through the common authorization, header, and logging boundary. */
export class V1HttpStreamResponse {
  constructor(readonly body: ReadableStream<Uint8Array>) {}
}

/** Transport-independent host interface consumed by the v1 route handlers. */
export interface V1Runtime {
  getStatus(): CocodStatus;
  getRunningSession(): RunningCocoSession | null;
  initializeWallet(input: InitializeWalletInput): Promise<InitializeWalletResult>;
  getWalletRecoveryMaterial(input?: WalletRecoveryMaterialInput): Promise<string>;
  startSession(input?: StartSessionRequest): SessionStartTransition;
  stopSession(): Promise<void>;
}

/** Preserves handler input, output, and parameter types while erasing them for the runner. */
export function defineV1Route<TRequest, TResponse, P extends V1Parameters = Record<never, never>>(
  definition: V1RouteDefinition<TRequest, TResponse, P>,
): V1RouteDefinition {
  return {
    ...definition,
    successStatuses: definition.successStatuses ?? [200],
    idempotencyKey: definition.idempotencyKey ?? null,
    responseCacheControl: definition.responseCacheControl ?? null,
    responseMediaType: definition.responseMediaType ?? 'application/json',
    parameters: definition.parameters ?? {},
    handler: (input, context) =>
      definition.handler(input as TRequest, context as unknown as V1RequestContext<P>),
  };
}
