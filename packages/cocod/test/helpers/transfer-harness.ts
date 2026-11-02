import { Database } from 'bun:sqlite';

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeCoco, type Manager } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import type { CocodStatus, RunningCocoSession } from '../../src/runtime.js';
import {
  buildV1FallbackHandler,
  buildV1Routes,
  createV1RouteDefinitions,
  type V1Runtime,
} from '../../src/v1/http.js';
import { startFakeMint, type FakeMint } from './fake-mint.js';
import { startTcpTestServer } from './tcp.js';

const UNREACHABLE_MINT = 'http://127.0.0.1:1';
const cleanups: Array<() => Promise<void>> = [];
export async function cleanupTransferHarnesses() {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}
export function addTransferCleanup(cleanup: () => Promise<void>) {
  cleanups.push(cleanup);
}

function runningStatus(): CocodStatus {
  return {
    wallet: { configuredAt: '2026-10-29T00:00:00.000Z', mintUrl: UNREACHABLE_MINT },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: { state: 'running', startedAt: '2026-10-29T00:00:01.000Z', lastFailure: null },
  } as CocodStatus;
}

export interface TransferHarness {
  manager: Manager;
  repositories: SqliteRepositories;
  mint: FakeMint;
  /** Replaces the reported lifecycle; a non-running state hides the Coco Session. */
  setStatus(status: CocodStatus): void;
  call(
    method: 'GET' | 'POST',
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; credential?: string },
  ): Promise<Response>;
  readOnlyCredential(): Promise<string>;
  clientCredentialFile: string;
  url: string;
  adminCredential: string;
}

export async function startTransferHarness(
  options: { mintUrl?: string } = {},
): Promise<TransferHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-transfers-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const mint = options.mintUrl
    ? { url: options.mintUrl, requests: [], stop: async () => {} }
    : startFakeMint();
  cleanups.push(() => mint.stop());

  const database = new Database(join(directory, 'wallet.sqlite'));
  cleanups.push(async () => database.close());
  const repositories = new SqliteRepositories({ database });
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const manager = await initializeCoco({
    repo: repositories,
    seedGetter: async () => seed,
    requestRateLimit: { disabled: true },
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
      mintSwapOperationProcessor: { disabled: true },
    },
  });
  cleanups.push(() => manager.dispose());

  let status = runningStatus();
  const session: RunningCocoSession = {
    manager,
    mintUrl: mint.url,
    npcAccount: {} as RunningCocoSession['npcAccount'],
  };
  const runtime: V1Runtime = {
    getStatus: () => status,
    getRunningSession: () => (status.cocoSession.state === 'running' ? session : null),
    initializeWallet: () => Promise.reject(new Error('unexpected')),
    getWalletRecoveryMaterial: () => Promise.reject(new Error('unexpected')),
    startSession: () => {
      throw new Error('unexpected');
    },
    stopSession: () => Promise.reject(new Error('unexpected')),
  };

  const paths = {
    credentialDirectory: join(directory, 'credentials'),
    verifierFile: join(directory, 'credentials', 'current', 'verifier.json'),
    clientCredentialFile: join(directory, 'credentials', 'current', 'client'),
  };
  const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
  const adminCredential = await loadClientCredential(paths.clientCredentialFile);
  const shutdown = { request: () => Promise.reject(new Error('unexpected')) };
  const server = startTcpTestServer({
    routes: buildV1Routes(createV1RouteDefinitions(runtime, '0.0.17', shutdown), credentials),
    fetch: buildV1FallbackHandler(credentials, async () => new Response('legacy', { status: 404 })),
  });
  cleanups.push(() => server.stop(true));
  const url = server.url.toString().replace(/\/$/, '');

  return {
    manager,
    repositories,
    mint,
    url,
    adminCredential,
    clientCredentialFile: paths.clientCredentialFile,
    setStatus: (next) => {
      status = next;
    },
    call: (method, path, callOptions = {}) =>
      fetch(`${url}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${callOptions.credential ?? adminCredential}`,
          ...(callOptions.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...callOptions.headers,
        },
        ...(callOptions.body !== undefined ? { body: JSON.stringify(callOptions.body) } : {}),
      }),
    // Narrows the stored verifier to `wallet:read`; authorization re-reads it on every request.
    readOnlyCredential: async () => {
      const state = JSON.parse(await readFile(paths.verifierFile, 'utf8')) as {
        capabilities: string[];
      };
      state.capabilities = ['wallet:read'];
      await writeFile(paths.verifierFile, JSON.stringify(state), { mode: 0o600 });
      return adminCredential;
    },
  };
}
