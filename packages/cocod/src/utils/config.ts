import { isIP } from 'node:net';
import { homedir } from 'node:os';

export const CONFIG_DIR = `${homedir()}/.cocod`;
export const PID_FILE = process.env.COCOD_PID || `${CONFIG_DIR}/cocod.pid`;
export const LOG_FILE = process.env.COCOD_LOG_FILE || `${CONFIG_DIR}/daemon.log`;
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
export const SALT_FILE = `${CONFIG_DIR}/salt`;
export const DB_FILE = `${CONFIG_DIR}/coco.db`;
export const CREDENTIAL_DIRECTORY = `${CONFIG_DIR}/credentials`;
export const CREDENTIAL_CURRENT_DIRECTORY = `${CREDENTIAL_DIRECTORY}/current`;
export const CREDENTIAL_VERIFIER_FILE = `${CREDENTIAL_CURRENT_DIRECTORY}/verifier.json`;
export const CLIENT_CREDENTIAL_FILE = `${CREDENTIAL_CURRENT_DIRECTORY}/client`;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
export const DEFAULT_LISTEN_HOST = '127.0.0.1';
export const DEFAULT_LISTEN_PORT = 62626;
export const DEFAULT_CLIENT_URL = `http://${DEFAULT_LISTEN_HOST}:${DEFAULT_LISTEN_PORT}`;

type Environment = Readonly<Record<string, string | undefined>>;

export interface ListenerConfig {
  hostname: string;
  port: number;
}

export interface ClientEndpoint {
  url: string;
  explicit: boolean;
}

/** Resolves and validates the single TCP listener before cocod binds. */
export function resolveListenerConfig(environment: Environment = process.env): ListenerConfig {
  const hostname = readListenHost(environment.COCOD_LISTEN_HOST);
  const port = readListenPort(environment.COCOD_LISTEN_PORT);
  return { hostname, port };
}

/** Selects one HTTP origin for liveness, ordinary requests, and streams. */
export function resolveClientEndpoint(
  commandUrl?: string,
  environment: Environment = process.env,
): ClientEndpoint {
  const configuredUrl = commandUrl ?? environment.COCOD_URL;
  if (configuredUrl === undefined) {
    return { url: DEFAULT_CLIENT_URL, explicit: false };
  }

  if (configuredUrl.length === 0 || configuredUrl.trim() !== configuredUrl) {
    throw new Error('Cocod URL must be a valid HTTP origin');
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch (error) {
    throw new Error('Cocod URL must be a valid HTTP origin', { cause: error });
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('Cocod URL must be an HTTP origin without credentials, a path, or a query');
  }

  return { url: url.origin, explicit: true };
}

export function listenerUrl(listener: ListenerConfig): string {
  const hostname = isIP(listener.hostname) === 6 ? `[${listener.hostname}]` : listener.hostname;
  return `http://${hostname}:${listener.port}`;
}

function readListenHost(configuredHost: string | undefined): string {
  if (configuredHost === undefined) {
    return DEFAULT_LISTEN_HOST;
  }
  if (
    configuredHost.length === 0 ||
    configuredHost.trim() !== configuredHost ||
    configuredHost.includes('/') ||
    configuredHost.includes('://')
  ) {
    throw new Error('COCOD_LISTEN_HOST must be a valid hostname or IP address');
  }
  if (isIP(configuredHost) !== 0) {
    return configuredHost;
  }
  if (
    configuredHost.length > 253 ||
    !configuredHost
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
      )
  ) {
    throw new Error('COCOD_LISTEN_HOST must be a valid hostname or IP address');
  }
  return configuredHost;
}

function readListenPort(configuredPort: string | undefined): number {
  if (configuredPort === undefined) {
    return DEFAULT_LISTEN_PORT;
  }
  if (!/^\d+$/.test(configuredPort)) {
    throw new Error('COCOD_LISTEN_PORT must be an integer between 1 and 65535');
  }
  const port = Number(configuredPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('COCOD_LISTEN_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export interface WalletConfig {
  version: number;
  mnemonic: string;
  encrypted: boolean;
  mintUrl: string;
  createdAt: string;
}
