import { program } from 'commander';

import { ClientCredentialFileError, loadClientCredential } from './credentials.js';
import {
  CLIENT_CREDENTIAL_FILE,
  DEFAULT_CLIENT_URL,
  resolveClientEndpoint,
  type ClientEndpoint,
} from './utils/config.js';

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
  return new URL(path, DEFAULT_CLIENT_URL).pathname !== '/ping';
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
    const endpoint = configuredClientEndpoint(options.url);
    const response = await requestDaemon(endpoint, '/ping', { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

async function isDaemonReady(options: ClientCredentialOptions = {}): Promise<boolean> {
  try {
    const body = await callDaemon('/status', options);
    return body.output !== 'STARTING' && body.output !== 'STOPPING';
  } catch (error) {
    if (error instanceof ClientCredentialFileError) {
      throw error;
    }
    return false;
  }
}

async function waitForDaemonReady(
  options: ClientCredentialOptions = {},
  retryMissingCredential = false,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if (await isDaemonReady(options)) {
        return;
      }
    } catch (error) {
      if (!(retryMissingCredential && error instanceof ClientCredentialFileError)) {
        throw error;
      }
      if (await isDaemonRunning(options)) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Daemon failed to become ready within 5 seconds');
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
  await waitForDaemonReady(options, true);
}

export async function ensureDaemonRunning(options: ClientCredentialOptions = {}): Promise<void> {
  const endpoint = configuredClientEndpoint(options.url);
  if (await isDaemonRunning({ ...options, url: endpoint.url })) {
    await waitForDaemonReady({ ...options, url: endpoint.url });
    return;
  }

  if (endpoint.explicit) {
    throw explicitEndpointUnavailable(endpoint.url);
  }

  console.log('Starting daemon...');
  await startDaemonProcess({ ...options, url: undefined });
}

export async function handleDaemonCommand(
  path: string,
  options: DaemonCallOptions = {},
): Promise<CommandResponse> {
  try {
    await ensureDaemonRunning({ credentialFile: options.credentialFile, url: options.url });
    const result = await callDaemon(path, options);

    if (result.error) {
      console.log(result.error);
      process.exit(1);
    }

    if (result.output !== undefined) {
      if (typeof result.output === 'string') {
        console.log(result.output);
      } else {
        try {
          const formatted = JSON.stringify(result.output, null, 2);
          console.log(formatted ?? String(result.output));
        } catch {
          console.log(String(result.output));
        }
      }
    }

    return result;
  } catch (error) {
    const message = (error as Error).message;
    if (message?.includes('fetch failed') || message?.includes('Connection refused')) {
      console.error('Daemon is not running and failed to auto-start');
      process.exit(1);
    }
    console.error(message);
    process.exit(1);
  }
}

export async function callDaemonStream(
  path: string,
  onData: (data: unknown) => void,
  options: ClientCredentialOptions = {},
): Promise<void> {
  await ensureDaemonRunning(options);
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
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            onData(data);
          } catch {
            // Skip malformed JSON
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

function explicitEndpointUnavailable(url: string): Error {
  return new Error(
    `Cannot connect to the explicit Cocod endpoint ${url}; no local process was started`,
  );
}

export { program, callDaemon };
