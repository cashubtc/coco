import { program } from 'commander';

import { ClientCredentialFileError, loadClientCredential } from './credentials.js';
import { CLIENT_CREDENTIAL_FILE, SOCKET_PATH } from './utils/config.js';

export interface CommandResponse {
  output?: unknown;
  error?: string;
}

export interface ClientCredentialOptions {
  credentialFile?: string;
}

export interface DaemonCallOptions extends ClientCredentialOptions {
  method?: 'GET' | 'POST';
  body?: object;
}

async function callDaemon(path: string, options: DaemonCallOptions = {}): Promise<CommandResponse> {
  const { method = 'GET', body, credentialFile = CLIENT_CREDENTIAL_FILE } = options;
  const headers = await buildRequestHeaders(path, credentialFile, body !== undefined);

  const init: RequestInit & { unix: string } = {
    unix: SOCKET_PATH,
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  } as RequestInit & { unix: string };

  const response = await fetch(`http://localhost${path}`, init);

  if (!response.ok) {
    const errorData = (await response.json()) as { error?: string };
    throw new Error(errorData.error || `HTTP ${response.status}`);
  }

  return response.json() as Promise<CommandResponse>;
}

function isProtectedPath(path: string): boolean {
  return new URL(path, 'http://localhost').pathname !== '/ping';
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

export async function isDaemonRunning(): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost/ping`, {
      unix: SOCKET_PATH,
    } as RequestInit);
    return response.ok;
  } catch {
    return false;
  }
}

async function isDaemonReady(credentialFile = CLIENT_CREDENTIAL_FILE): Promise<boolean> {
  try {
    const body = await callDaemon('/status', { credentialFile });
    return body.output !== 'STARTING' && body.output !== 'STOPPING';
  } catch (error) {
    if (error instanceof ClientCredentialFileError) {
      throw error;
    }
    return false;
  }
}

async function waitForDaemonReady(
  credentialFile = CLIENT_CREDENTIAL_FILE,
  retryMissingCredential = false,
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      if (await isDaemonReady(credentialFile)) {
        return;
      }
    } catch (error) {
      if (!(retryMissingCredential && error instanceof ClientCredentialFileError)) {
        throw error;
      }
      if (await isDaemonRunning()) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error('Daemon failed to become ready within 5 seconds');
}

export async function startDaemonProcess(options: ClientCredentialOptions = {}): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', `${import.meta.dir}/index.ts`, 'daemon'],
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  proc.unref();
  await waitForDaemonReady(options.credentialFile, true);
}

export async function ensureDaemonRunning(options: ClientCredentialOptions = {}): Promise<void> {
  if (await isDaemonRunning()) {
    await waitForDaemonReady(options.credentialFile);
    return;
  }

  console.log('Starting daemon...');
  await startDaemonProcess(options);
}

export async function handleDaemonCommand(
  path: string,
  options: DaemonCallOptions = {},
): Promise<CommandResponse> {
  try {
    await ensureDaemonRunning({ credentialFile: options.credentialFile });
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

  const init: RequestInit & { unix: string } = {
    unix: SOCKET_PATH,
    method: 'GET',
    headers: await buildRequestHeaders(path, options.credentialFile),
  } as RequestInit & { unix: string };

  const response = await fetch(`http://localhost${path}`, init);

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

export { program, callDaemon };
