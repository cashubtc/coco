import { program } from 'commander';

import { loadClientCredential } from './credentials.js';
import {
  healthSchema,
  initializeWalletResponseSchema,
  lifecycleStatusSchema,
  processShutdownResponseSchema,
  v1ErrorSchema,
  walletRecoveryMaterialResponseSchema,
  type HealthDocument,
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
export const DEFAULT_SESSION_TRANSITION_TIMEOUT_MS = DEFAULT_SHUTDOWN_TIMEOUT_MS + 5_000;

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
  };
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

export async function callDaemonStream(
  path: string,
  onData: (data: unknown) => void,
  options: ClientCredentialOptions = {},
): Promise<void> {
  await ensureDaemonRunning(options);
  await waitForOperationalSession(createV1Client(options));
  const endpoint = configuredClientEndpoint(options.url);
  const response = await requestDaemon(endpoint, path, options);

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  if (!response.body) {
    throw new Error('No response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            onData(JSON.parse(line.slice(6)));
          } catch {
            // Ignore malformed event data and continue reading the stream.
          }
        }
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
  const document: unknown = await response.json();

  if (!response.ok) {
    try {
      const error = v1ErrorSchema.parse(document).error;
      throw new V1ClientError(
        error.message,
        response.status,
        error.code,
        error.retryable,
        error.details,
      );
    } catch (error) {
      if (error instanceof V1ClientError) {
        throw error;
      }
      throw new Error(`HTTP ${response.status}: invalid v1 error response`);
    }
  }

  try {
    return schema.parse(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${schema.name} response: ${message}`);
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
  if (message.includes('fetch failed') || message.includes('Connection refused')) {
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
