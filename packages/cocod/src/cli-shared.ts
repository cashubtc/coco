import type { LifecycleOperationType } from '@cashu/coco-core';
import { program } from 'commander';

import { loadClientCredential } from './credentials.js';
import {
  balancesSchema,
  executeMeltOperationResponseSchema,
  executeSendOperationResponseSchema,
  healthSchema,
  historyPageSchema,
  historySchema,
  initializeWalletResponseSchema,
  knownMintSchema,
  knownMintsSchema,
  lifecycleStatusSchema,
  meltOperationSchema,
  meltQuoteSchema,
  mintInformationSchema,
  mintOperationSchema,
  mintQuoteSchema,
  paymentRequestEvaluationSchema,
  processShutdownResponseSchema,
  receiveOperationSchema,
  resourceEventSchema,
  sendOperationSchema,
  v1ErrorSchema,
  walletRecoveryMaterialResponseSchema,
  type BalancesDocument,
  type CreateMeltQuoteRequest,
  type CreateMintQuoteRequest,
  type ExecuteMeltOperationResponse,
  type ExecuteSendOperationResponse,
  type HealthDocument,
  type HistoryDocument,
  type KnownMintDocument,
  type KnownMintsDocument,
  type MeltOperationDocument,
  type MeltQuoteDocument,
  type MintInformationDocument,
  type MintOperationDocument,
  type MintQuoteDocument,
  type PageDocument,
  type PaymentRequestEvaluationDocument,
  type PrepareMeltOperationRequest,
  type PrepareMintOperationRequest,
  type PrepareSendOperationRequest,
  type ReceiveOperationDocument,
  type RegisterMintRequest,
  type ResourceEventDocument,
  type SendOperationDocument,
  type InitializeWalletRequest,
  type InitializeWalletResponseDocument,
  type LifecycleStatusDocument,
  type ProcessShutdownResponseDocument,
  type RuntimeSchema,
  type StartSessionRequest,
  type V1ErrorCode,
  type WalletRecoveryMaterialRequest,
  type WalletRecoveryMaterialResponseDocument,
} from './v1/http.js';
import {
  CLIENT_CREDENTIAL_FILE,
  DEFAULT_CLIENT_URL,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  resolveClientEndpoint,
  type ClientEndpoint,
} from './utils/config.js';

const SESSION_TRANSITION_POLL_INTERVAL_MS = 100;
const HISTORY_WATCH_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_SESSION_TRANSITION_TIMEOUT_MS = DEFAULT_SHUTDOWN_TIMEOUT_MS + 5_000;

const OPERATION_SCHEMAS = {
  mint: mintOperationSchema,
  melt: meltOperationSchema,
  send: sendOperationSchema,
  receive: receiveOperationSchema,
};

const OPERATION_LABELS: Record<LifecycleOperationType, string> = {
  mint: 'Mint',
  melt: 'Melt',
  send: 'Send',
  receive: 'Receive',
};

export type OperationDocument =
  | MintOperationDocument
  | MeltOperationDocument
  | SendOperationDocument
  | ReceiveOperationDocument;

/** Operation families with a cancel command; a Mint Operation has no reservations to release. */
export type CancellableOperationType = Exclude<LifecycleOperationType, 'mint'>;

export interface CommandResponse {
  output?: unknown;
  error?: string;
}

export interface ClientCredentialOptions {
  credentialFile?: string;
  url?: string;
}

export interface DaemonCallOptions extends ClientCredentialOptions {
  method?: 'GET' | 'POST';
  body?: object;
}

export interface SessionTransitionWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface V1Client {
  health(): Promise<HealthDocument>;
  status(): Promise<LifecycleStatusDocument>;
  initializeWallet(input: InitializeWalletRequest): Promise<InitializeWalletResponseDocument>;
  getWalletRecoveryMaterial(
    input: WalletRecoveryMaterialRequest,
  ): Promise<WalletRecoveryMaterialResponseDocument>;
  startSession(input: StartSessionRequest): Promise<LifecycleStatusDocument>;
  stopSession(): Promise<LifecycleStatusDocument>;
  stopProcess(): Promise<ProcessShutdownResponseDocument>;
  balances(): Promise<BalancesDocument>;
  listMints(query?: { trustedOnly?: boolean }): Promise<KnownMintsDocument>;
  registerMint(input: RegisterMintRequest): Promise<KnownMintDocument>;
  getMintInfo(mintUrl: string): Promise<MintInformationDocument>;
  createMintQuote(input: CreateMintQuoteRequest): Promise<MintQuoteDocument>;
  createMeltQuote(input: CreateMeltQuoteRequest): Promise<MeltQuoteDocument>;
  prepareMint(input: PrepareMintOperationRequest): Promise<MintOperationDocument>;
  prepareMelt(input: PrepareMeltOperationRequest): Promise<MeltOperationDocument>;
  executeMelt(operationId: string): Promise<ExecuteMeltOperationResponse>;
  prepareSend(input: PrepareSendOperationRequest): Promise<SendOperationDocument>;
  executeSend(operationId: string): Promise<ExecuteSendOperationResponse>;
  prepareReceive(token: string): Promise<ReceiveOperationDocument>;
  executeReceive(operationId: string): Promise<ReceiveOperationDocument>;
  getOperation(type: LifecycleOperationType, operationId: string): Promise<OperationDocument>;
  cancelOperation(type: CancellableOperationType, operationId: string): Promise<OperationDocument>;
  evaluatePaymentRequest(request: string): Promise<PaymentRequestEvaluationDocument>;
  listHistory(query: { offset: number; limit: number }): Promise<PageDocument<HistoryDocument>>;
  getHistoryEntry(id: string): Promise<HistoryDocument>;
  /**
   * Streams resource events until the stream ends or `signal` aborts. `onOpen` runs once the stream
   * is established, so a client that refetches then cannot miss a later invalidation.
   */
  watchEvents(
    onEvent: (event: ResourceEventDocument) => void,
    options?: { signal?: AbortSignal; onOpen?: () => void },
  ): Promise<void>;
}

export class V1ClientError extends Error {
  override readonly name = 'V1ClientError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: V1ErrorCode,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** A command failed without a v1 error after preparation, such as a dropped connection. */
export class OperationExecutionError extends Error {
  override readonly name = 'OperationExecutionError';
}

export function assertHostLocalOperation(
  operation: string,
  commandUrl = program.opts<{ url?: string }>().url,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const endpoint = resolveClientEndpoint(commandUrl, environment);
  if (endpoint.explicit) {
    throw new Error(
      `cocod ${operation} is host-local and cannot use the explicit Cocod endpoint ${endpoint.url}`,
    );
  }
}

/** Creates one typed client for the implemented v1 lifecycle interface. */
export function createV1Client(options: ClientCredentialOptions = {}): V1Client {
  const endpoint = configuredClientEndpoint(options.url);
  const credentialFile = options.credentialFile;

  return {
    health: () => requestV1(endpoint, '/health', 'GET', undefined, healthSchema, credentialFile),
    status: () =>
      requestV1(endpoint, '/v1/status', 'GET', undefined, lifecycleStatusSchema, credentialFile),
    initializeWallet: (input) =>
      requestV1(
        endpoint,
        '/v1/admin/wallet/initialize',
        'POST',
        input,
        initializeWalletResponseSchema,
        credentialFile,
      ),
    getWalletRecoveryMaterial: (input) =>
      requestV1(
        endpoint,
        '/v1/admin/wallet/recovery-material',
        'POST',
        input,
        walletRecoveryMaterialResponseSchema,
        credentialFile,
      ),
    startSession: (input) =>
      requestV1(
        endpoint,
        '/v1/admin/session/start',
        'POST',
        input,
        lifecycleStatusSchema,
        credentialFile,
      ),
    stopSession: () =>
      requestV1(
        endpoint,
        '/v1/admin/session/stop',
        'POST',
        {},
        lifecycleStatusSchema,
        credentialFile,
      ),
    stopProcess: () =>
      requestV1(
        endpoint,
        '/v1/admin/process/stop',
        'POST',
        {},
        processShutdownResponseSchema,
        credentialFile,
      ),
    balances: () => get('/v1/balances', balancesSchema),
    listMints: (query = {}) =>
      get(
        withQuery(
          '/v1/mints',
          query.trustedOnly === undefined ? {} : { trustedOnly: `${query.trustedOnly}` },
        ),
        knownMintsSchema,
      ),
    registerMint: (input) => post('/v1/mints', input, knownMintSchema),
    getMintInfo: (mintUrl) => get(withQuery('/v1/mints/info', { mintUrl }), mintInformationSchema),
    createMintQuote: (input) => post('/v1/quotes/mint', input, mintQuoteSchema),
    createMeltQuote: (input) => post('/v1/quotes/melt', input, meltQuoteSchema),
    prepareMint: (input) => post('/v1/operations/mint', input, mintOperationSchema),
    prepareMelt: (input) => post('/v1/operations/melt', input, meltOperationSchema),
    executeMelt: (operationId) =>
      post(
        operationPath('melt', operationId, 'execute'),
        undefined,
        executeMeltOperationResponseSchema,
      ),
    prepareSend: (input) => post('/v1/operations/send', input, sendOperationSchema),
    executeSend: (operationId) =>
      post(
        operationPath('send', operationId, 'execute'),
        undefined,
        executeSendOperationResponseSchema,
      ),
    prepareReceive: (token) => post('/v1/operations/receive', { token }, receiveOperationSchema),
    executeReceive: (operationId) =>
      post(operationPath('receive', operationId, 'execute'), undefined, receiveOperationSchema),
    getOperation: (type, operationId) =>
      get<OperationDocument>(operationPath(type, operationId), OPERATION_SCHEMAS[type]),
    cancelOperation: (type, operationId) =>
      post<OperationDocument>(
        operationPath(type, operationId, 'cancel'),
        undefined,
        OPERATION_SCHEMAS[type],
      ),
    evaluatePaymentRequest: (request) =>
      post('/v1/payment-requests/evaluate', { request }, paymentRequestEvaluationSchema),
    listHistory: ({ offset, limit }) =>
      get(withQuery('/v1/history', { offset: `${offset}`, limit: `${limit}` }), historyPageSchema),
    getHistoryEntry: (id) => get(`/v1/history/${encodeURIComponent(id)}`, historySchema),
    watchEvents: (onEvent, options) => watchV1Events(endpoint, credentialFile, onEvent, options),
  };

  function get<T>(path: string, schema: RuntimeSchema<T>): Promise<T> {
    return requestV1(endpoint, path, 'GET', undefined, schema, credentialFile);
  }

  function post<T>(path: string, body: object | undefined, schema: RuntimeSchema<T>): Promise<T> {
    return requestV1(endpoint, path, 'POST', body, schema, credentialFile);
  }
}

function withQuery(path: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return search ? `${path}?${search}` : path;
}

function operationPath(
  type: LifecycleOperationType,
  operationId: string,
  command?: string,
): string {
  const path = `/v1/operations/${type}/${encodeURIComponent(operationId)}`;
  return command ? `${path}/${command}` : path;
}

/** Creates a BOLT11 Mint Quote and its pending Mint Operation; returns the invoice to pay. */
export async function requestBolt11Receive(
  client: V1Client,
  input: { amount: string; mintUrl?: string },
): Promise<string> {
  const quote = await client.createMintQuote({
    method: 'bolt11',
    amount: input.amount,
    unit: 'sat',
    ...(input.mintUrl !== undefined ? { mintUrl: input.mintUrl } : {}),
  });
  await client.prepareMint({
    mintUrl: quote.mintUrl,
    quoteId: quote.quoteId,
    amount: input.amount,
  });
  return quote.request;
}

/** Prepares and executes a Cashu Send; returns the encoded token. */
export async function sendCashu(
  client: V1Client,
  input: { amount: string; mintUrl?: string },
): Promise<string> {
  const prepared = await client.prepareSend({
    amount: input.amount,
    unit: 'sat',
    ...(input.mintUrl !== undefined ? { mintUrl: input.mintUrl } : {}),
  });
  const executed = await executeOrExplain(client, 'send', prepared.id, () =>
    client.executeSend(prepared.id),
  );
  return executed.result.token;
}

/** Prepares and executes a BOLT11 Melt; reports whether the payment settled. */
export async function payBolt11Invoice(
  client: V1Client,
  input: { invoice: string; mintUrl?: string },
): Promise<string> {
  const quote = await client.createMeltQuote({
    method: 'bolt11',
    invoice: input.invoice,
    ...(input.mintUrl !== undefined ? { mintUrl: input.mintUrl } : {}),
  });
  const prepared = await client.prepareMelt({ mintUrl: quote.mintUrl, quoteId: quote.quoteId });
  const { operation } = await executeOrExplain(client, 'melt', prepared.id, () =>
    client.executeMelt(prepared.id),
  );
  return operation.state === 'finalized'
    ? 'Invoice paid'
    : `Payment ${operation.state}; Melt Operation ${operation.id}`;
}

/** Prepares and executes a Cashu Receive. */
export async function receiveCashu(client: V1Client, token: string): Promise<string> {
  const prepared = await client.prepareReceive(token);
  const received = await executeOrExplain(client, 'receive', prepared.id, () =>
    client.executeReceive(prepared.id),
  );
  return `Received ${received.amount} ${received.unit}`;
}

/** Describes an outgoing Payment Request for a person. */
export async function describePaymentRequest(client: V1Client, request: string): Promise<string> {
  const evaluation = await client.evaluatePaymentRequest(request);
  const amount =
    evaluation.amount === undefined
      ? 'an amount you choose'
      : `${evaluation.amount} ${evaluation.unit}`;
  const mints =
    evaluation.allowedMints.length > 0
      ? `from one of ${evaluation.allowedMints.length} Mints`
      : 'from any Mint';
  const payable =
    evaluation.payableMints.length > 0 ? evaluation.payableMints.join('\n') : 'No payable Mint';
  return `Request requires payment of ${amount} ${mints} over ${evaluation.transport.type} transport.\nPayable Mints:\n${payable}`;
}

/** Pays an in-band Payment Request; returns the X-Cashu header carrying the token. */
export async function payPaymentRequest(client: V1Client, request: string): Promise<string> {
  const prepared = await client.prepareSend({ source: { type: 'payment-request', request } });
  const executed = await executeOrExplain(client, 'send', prepared.id, () =>
    client.executeSend(prepared.id),
  );
  return `X-Cashu: ${executed.result.token}`;
}

/**
 * Names the prepared Operation when execution fails so the person can inspect or cancel it. A failed
 * execution may still have reached the Mint, so the explanation comes from a fresh read.
 */
async function executeOrExplain<T>(
  client: V1Client,
  type: CancellableOperationType,
  operationId: string,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const message = `${reason}; ${await explainOperation(client, type, operationId)}`;
    if (error instanceof V1ClientError) {
      throw new V1ClientError(message, error.status, error.code, error.retryable, error.details);
    }
    throw new OperationExecutionError(message, { cause: error });
  }
}

async function explainOperation(
  client: V1Client,
  type: CancellableOperationType,
  operationId: string,
): Promise<string> {
  const label = `${OPERATION_LABELS[type]} Operation ${operationId}`;
  const inspect = `inspect it with \`cocod operations show ${type} ${operationId}\``;
  try {
    const { state } = await client.getOperation(type, operationId);
    return state === 'prepared'
      ? `${label} is still prepared; ${inspect} or cancel it with \`cocod operations cancel ${type} ${operationId}\``
      : `${label} is ${state}; ${inspect}`;
  } catch {
    return `the state of ${label} could not be read; ${inspect}`;
  }
}

export interface HistoryWatchOptions {
  /** Size of the first history page refetched on every (re)connection. */
  limit: number;
  /** Receives each new or changed entry once, as it is observed. */
  onEntry(entry: HistoryDocument): void;
  onDisconnect?(): void;
  reconnectDelayMs?: number;
}

/**
 * Reports history changes after `initial` until a non-retryable failure, such as a stopped Coco
 * Session. Events have no replay, so each connection refetches the first page once the stream is
 * open, and each invalidation refetches the entry it names.
 */
export async function watchHistory(
  client: V1Client,
  initial: readonly HistoryDocument[],
  options: HistoryWatchOptions,
): Promise<never> {
  const reported = new Map(initial.map((entry) => [entry.id, JSON.stringify(entry)]));
  const report = (entries: readonly HistoryDocument[]) => {
    for (const entry of entries) {
      const serialized = JSON.stringify(entry);
      if (reported.get(entry.id) === serialized) continue;
      reported.set(entry.id, serialized);
      options.onEntry(entry);
    }
  };

  while (true) {
    const stream = new AbortController();
    let refetches = Promise.resolve();
    // Serialized so entries are reported in the order they were invalidated. A failed refetch
    // closes the stream; this connection then ends with that failure.
    const refetch = (read: () => Promise<readonly HistoryDocument[]>) => {
      refetches = refetches.then(async () => report(await read()));
      refetches.catch(() => stream.abort());
    };

    try {
      await client.watchEvents(
        (event) => {
          if (event.type === 'history.updated') {
            refetch(() => readHistoryEntry(client, event.data.id));
          }
        },
        {
          signal: stream.signal,
          onOpen: () =>
            refetch(async () => {
              const { items } = await client.listHistory({ offset: 0, limit: options.limit });
              return items.toReversed();
            }),
        },
      );
      await refetches;
    } catch (error) {
      const failure = await refetches.then(
        () => error,
        (refetchFailure: unknown) => refetchFailure,
      );
      if (failure instanceof V1ClientError && !failure.retryable) throw failure;
    }
    options.onDisconnect?.();
    await Bun.sleep(options.reconnectDelayMs ?? HISTORY_WATCH_RECONNECT_DELAY_MS);
  }
}

/** An invalidated entry that no longer exists has nothing to report. */
async function readHistoryEntry(client: V1Client, id: string): Promise<HistoryDocument[]> {
  try {
    return [await client.getHistoryEntry(id)];
  } catch (error) {
    if (error instanceof V1ClientError && error.status === 404) return [];
    throw error;
  }
}

async function callDaemon(path: string, options: DaemonCallOptions = {}): Promise<CommandResponse> {
  const endpoint = configuredClientEndpoint(options.url);
  const response = await requestDaemon(endpoint, path, options);

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CommandResponse>;
}

function isProtectedPath(path: string): boolean {
  return new URL(path, DEFAULT_CLIENT_URL).pathname !== '/health';
}

async function buildRequestHeaders(
  path: string,
  credentialFile: string | undefined,
  hasJsonBody = false,
): Promise<Headers> {
  const headers = new Headers();
  if (hasJsonBody) {
    headers.set('Content-Type', 'application/json');
  }
  if (isProtectedPath(path)) {
    headers.set('Authorization', `Bearer ${await loadClientCredential(credentialFile)}`);
  }
  return headers;
}

export async function isDaemonRunning(options: ClientCredentialOptions = {}): Promise<boolean> {
  try {
    await createV1Client(options).health();
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemonReachable(options: ClientCredentialOptions = {}): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await isDaemonRunning(options)) {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error('Cocod Process failed to become reachable within 5 seconds');
}

export async function startDaemonProcess(options: ClientCredentialOptions = {}): Promise<void> {
  const endpoint = configuredClientEndpoint(options.url);
  if (endpoint.explicit) {
    throw explicitEndpointUnavailable(endpoint.url);
  }
  const proc = Bun.spawn({
    cmd: ['bun', 'run', `${import.meta.dir}/index.ts`, 'daemon'],
    env: {
      ...process.env,
      COCOD_LISTEN_HOST: undefined,
      COCOD_LISTEN_PORT: undefined,
    },
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  proc.unref();
  await waitForDaemonReachable(options);
}

export async function ensureDaemonRunning(options: ClientCredentialOptions = {}): Promise<void> {
  const endpoint = configuredClientEndpoint(options.url);
  if (await isDaemonRunning({ ...options, url: endpoint.url })) {
    return;
  }

  if (endpoint.explicit) {
    throw explicitEndpointUnavailable(endpoint.url);
  }

  console.log('Starting Cocod Process...');
  await startDaemonProcess({ ...options, url: undefined });
}

/** Polls only while a Coco Session lifecycle transition is still in progress. */
export async function waitForSessionTransition(
  client: V1Client,
  initialStatus: LifecycleStatusDocument,
  options: SessionTransitionWaitOptions = {},
): Promise<LifecycleStatusDocument> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SESSION_TRANSITION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SESSION_TRANSITION_POLL_INTERVAL_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Session transition timeout must be a positive finite number');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error('Session transition poll interval must be a positive finite number');
  }

  const startedAt = performance.now();
  let status = initialStatus;
  while (status.cocoSession.state === 'starting' || status.cocoSession.state === 'stopping') {
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) {
      throw new Error(
        `Coco Session transition did not finish within ${Math.ceil(timeoutMs / 1_000)} seconds`,
      );
    }
    await Bun.sleep(Math.min(pollIntervalMs, remainingMs));
    status = await client.status();
  }

  return status;
}

async function waitForOperationalSession(client: V1Client): Promise<void> {
  await waitForSessionTransition(client, await client.status());
}

export async function handleV1Command<T>(
  action: (client: V1Client) => Promise<T>,
  options: ClientCredentialOptions = {},
): Promise<T> {
  try {
    await ensureDaemonRunning(options);
    return await action(createV1Client(options));
  } catch (error) {
    exitForClientError(error);
  }
}

/** Runs a Wallet command once any in-progress Coco Session transition has finished. */
export async function handleWalletCommand<T>(
  action: (client: V1Client) => Promise<T>,
  options: ClientCredentialOptions = {},
): Promise<T> {
  try {
    await ensureDaemonRunning(options);
    const client = createV1Client(options);
    await waitForOperationalSession(client);
    return await action(client);
  } catch (error) {
    exitForClientError(error);
  }
}

export async function handleDaemonCommand(
  path: string,
  options: DaemonCallOptions = {},
): Promise<CommandResponse> {
  try {
    await ensureDaemonRunning({ credentialFile: options.credentialFile, url: options.url });
    await waitForOperationalSession(createV1Client(options));
    const result = await callDaemon(path, options);

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output !== undefined) {
      printValue(result.output);
    }

    return result;
  } catch (error) {
    exitForClientError(error);
  }
}

/** Reads `/v1/events`, delivering each validated event document in order. */
async function watchV1Events(
  endpoint: ClientEndpoint,
  credentialFile: string | undefined,
  onEvent: (event: ResourceEventDocument) => void,
  options: { signal?: AbortSignal; onOpen?: () => void } = {},
): Promise<void> {
  const response = await fetch(new URL('/v1/events', `${endpoint.url}/`), {
    headers: await buildRequestHeaders('/v1/events', credentialFile ?? CLIENT_CREDENTIAL_FILE),
    signal: options.signal,
  });
  if (!response.ok) {
    throw await toClientError(response);
  }
  if (!response.body) {
    throw new Error('The event stream has no body');
  }
  options.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice('data: '.length))
          .join('\n');
        if (data) onEvent(resourceEventSchema.parse(JSON.parse(data)));
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function configuredClientEndpoint(url?: string): ClientEndpoint {
  const commandUrl = url ?? program.opts<{ url?: string }>().url;
  return resolveClientEndpoint(commandUrl);
}

async function requestDaemon(
  endpoint: ClientEndpoint,
  path: string,
  options: DaemonCallOptions = {},
): Promise<Response> {
  const { method = 'GET', body, credentialFile = CLIENT_CREDENTIAL_FILE } = options;
  return fetch(new URL(path, `${endpoint.url}/`), {
    method,
    headers: await buildRequestHeaders(path, credentialFile, body !== undefined),
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function requestV1<T>(
  endpoint: ClientEndpoint,
  path: string,
  method: 'GET' | 'POST',
  body: object | undefined,
  schema: RuntimeSchema<T>,
  credentialFile = CLIENT_CREDENTIAL_FILE,
): Promise<T> {
  const response = await requestDaemon(endpoint, path, { method, body, credentialFile });
  if (!response.ok) {
    throw await toClientError(response);
  }
  const document: unknown = await response.json();

  try {
    return schema.parse(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${schema.name} response: ${message}`);
  }
}

async function toClientError(response: Response): Promise<Error> {
  try {
    const error = v1ErrorSchema.parse(await response.json()).error;
    return new V1ClientError(
      error.message,
      response.status,
      error.code,
      error.retryable,
      error.details,
    );
  } catch {
    return new Error(`HTTP ${response.status}: invalid v1 error response`);
  }
}

function printValue(value: unknown): void {
  if (typeof value === 'string') {
    console.log(value);
    return;
  }
  try {
    console.log(JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    console.log(String(value));
  }
}

function exitForClientError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof OperationExecutionError) {
    // Keeps the Operation ID even when the connection failed with a message matched below.
    console.error(message);
  } else if (message.includes('fetch failed') || message.includes('Connection refused')) {
    console.error('Cocod Process is not running and failed to auto-start');
  } else if (error instanceof V1ClientError) {
    console.error(`${error.message} [${error.code}]`);
  } else {
    console.error(message);
  }
  process.exit(1);
}

function explicitEndpointUnavailable(url: string): Error {
  return new Error(
    `Cannot connect to the explicit Cocod endpoint ${url}; no local process was started`,
  );
}

export { program, callDaemon };
