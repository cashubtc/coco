import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeCoco, toAmount, type Manager } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';

import { AdministrativeCredential, loadClientCredential } from './credentials.js';
import { buildFallbackHandler, buildRoutes, createRouteHandlers } from './routes';
import { startTcpTestServer } from '../test/helpers/tcp.js';
import type { AppLogger } from './utils/logger.js';
import { type CocodRuntime, type CocodStatus, type RunningCocoSession } from './runtime';

// A creqB (TLV + bech32m) payment request for 21 sat carrying a P2PK NUT-10
// spending condition, generated once with the workspace @cashu/cashu-ts.
const CREQB_P2PK_FIXTURE =
  'CREQB1QYQQ2UN9WYKNZQSQPQQQQQQQQQQQQ9GRQQQSQPQQQYQQ2QQCDP68GURN8GHJ7MTFDE6ZUETCV9KHQMR99E3K7MGXQQX8GETNWSS8QCTED4JKUAQ8QQ0QZQQPQYPQQ9MGW368QUE69UHK27RPD4CXCEFWVDHK6TMSV9USSQZFQYQQZQQZQPPRQVNP89SKXCE3V56RSCEJX4JK2ETZ8YERSWTZX5CRXVTRVV6NWERP89NX2DEJVCEKVEFJ8QMRZEPJXC6XYERRXQMNGV3S893RZVPHVFSNYU24ZDV';

function fakeRuntime(
  status: CocodStatus,
  session: RunningCocoSession | null = null,
  overrides: Partial<CocodRuntime> = {},
): CocodRuntime {
  return {
    getStatus: () => status,
    getRunningSession: () => session,
    ...overrides,
  } as unknown as CocodRuntime;
}

function uninitializedRuntime(overrides: Partial<CocodRuntime> = {}): CocodRuntime {
  return fakeRuntime(
    {
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    },
    null,
    overrides,
  );
}

function runningRuntime(manager?: unknown): CocodRuntime {
  const fakeManager = (manager ?? {}) as Manager;
  const fakeNpcAccount = {} as unknown as import('coco-cashu-plugin-npc').NPCAccountApi;
  return fakeRuntime(
    {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession: {
        state: 'running',
        startedAt: '2026-08-16T00:00:01.000Z',
        lastFailure: null,
      },
    },
    {
      manager: fakeManager,
      mintUrl: 'https://mint.example.com',
      npcAccount: fakeNpcAccount,
    },
  );
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function credentialPaths(directory: string): {
  credentialDirectory: string;
  verifierFile: string;
  clientCredentialFile: string;
} {
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  return {
    credentialDirectory,
    verifierFile: join(currentDirectory, 'verifier.json'),
    clientCredentialFile: join(currentDirectory, 'client'),
  };
}

describe('routes', () => {
  test('does not expose superseded lifecycle command routes', () => {
    const routes = createRouteHandlers(uninitializedRuntime());

    expect(routes['/ping']).toBeUndefined();
    expect(routes['/status']).toBeUndefined();
    expect(routes['/init']).toBeUndefined();
    expect(routes['/unlock']).toBeUndefined();
  });

  test('rejects a protected route without a bearer credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-auth-'));
    try {
      const credentials = await AdministrativeCredential.loadOrBootstrap(
        credentialPaths(directory),
      );
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials);

      const response = await routes['/balance']!.GET!(new Request('http://localhost/balance'));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Unauthorized' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('serves authenticated normal and streaming legacy routes on one TCP listener', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-tcp-stream-'));
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      let publishHistory: ((payload: unknown) => void) | undefined;
      const runtime = runningRuntime({
        mint: { getAllTrustedMints: async () => [] },
        on: (_event: string, listener: (payload: unknown) => void) => {
          publishHistory = listener;
          return () => {};
        },
      });
      server = startTcpTestServer({
        routes: buildRoutes(createRouteHandlers(runtime), runtime, credentials),
        fetch: buildFallbackHandler(runtime, credentials),
      });

      const normal = await fetch(new URL('/mints/list', server.url), {
        headers: { Authorization: `Bearer ${plaintext}` },
      });
      const unauthorizedStream = await fetch(new URL('/events', server.url));
      const abort = new AbortController();
      const streamResponse = fetch(new URL('/events', server.url), {
        headers: { Authorization: `Bearer ${plaintext}` },
        signal: abort.signal,
      });

      expect(normal.status).toBe(200);
      expect(await normal.json()).toEqual({ output: '' });
      expect(unauthorizedStream.status).toBe(401);
      for (let attempt = 0; attempt < 20 && !publishHistory; attempt++) {
        await Bun.sleep(5);
      }
      expect(publishHistory).toBeFunction();
      publishHistory!({ id: 'history-1' });
      const stream = await streamResponse;
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toBe('text/event-stream');
      const chunk = await stream.body!.getReader().read();
      expect(new TextDecoder().decode(chunk.value)).toContain('"id":"history-1"');
      abort.abort();
    } finally {
      await server?.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('returns a generic forbidden response when a capability is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-capability-'));
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      const state = JSON.parse(await readFile(paths.verifierFile, 'utf8')) as {
        capabilities: string[];
      };
      state.capabilities = ['wallet:read'];
      await writeFile(paths.verifierFile, JSON.stringify(state), { mode: 0o600 });
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials);

      const response = await routes['/receive/cashu']!.POST!(
        new Request('http://localhost/receive/cashu', {
          method: 'POST',
          headers: { Authorization: `Bearer ${plaintext}` },
          body: '{}',
        }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('does not include bearer credentials or authorization headers in route logs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-redaction-'));
    try {
      const credentials = await AdministrativeCredential.loadOrBootstrap(
        credentialPaths(directory),
      );
      const entries: unknown[] = [];
      const logger = {
        child: () => logger,
        debug: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        error: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        info: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        log: (_level: string, message: string, ...meta: unknown[]) =>
          entries.push([message, ...meta]),
        warn: (message: string, ...meta: unknown[]) => entries.push([message, ...meta]),
        flush: async () => {},
      } as AppLogger;
      const runtime = uninitializedRuntime();
      const routes = buildRoutes(createRouteHandlers(runtime), runtime, credentials, logger);
      const presentedCredential = 'z'.repeat(43);

      const response = await routes['/balance']!.GET!(
        new Request('http://localhost/balance', {
          headers: { Authorization: `Bearer ${presentedCredential}` },
        }),
      );

      const logged = JSON.stringify(entries);
      expect(response.status).toBe(401);
      expect(logged).not.toContain(presentedCredential);
      expect(logged.toLowerCase()).not.toContain('authorization');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('removes legacy /stop and rejects new legacy work during process shutdown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cocod-routes-shutdown-'));
    try {
      const paths = credentialPaths(directory);
      const credentials = await AdministrativeCredential.loadOrBootstrap(paths);
      const plaintext = await loadClientCredential(paths.clientCredentialFile);
      const runtime = uninitializedRuntime();
      const definitions = createRouteHandlers(runtime);
      const routes = buildRoutes(definitions, runtime, credentials, undefined, {
        isAcceptingWork: () => false,
      });

      const response = await routes['/balance']!.GET!(
        new Request('http://localhost/balance', {
          headers: { Authorization: `Bearer ${plaintext}` },
        }),
      );

      expect(definitions['/stop']).toBeUndefined();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Daemon is shutting down' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('/x-cashu/parse requires request field', async () => {
    const runtime = runningRuntime();
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/parse']!.POST!(postJson('/x-cashu/parse', {}));

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Request is required');
  });

  test('/x-cashu/parse accepts a creqB request and keeps its P2PK lock intact', async () => {
    // Real core against an in-memory database: proves the workspace decoder does not
    // discard the NUT-10 condition and that core classifies it as an enforceable P2PK
    // lock. This test gates the removal of cocod's former creqB/NUT-10 rejections.
    const repo = new SqliteRepositories({ database: new Database(':memory:') });
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(7),
    });
    try {
      const parsed = await manager.paymentRequests.parse(CREQB_P2PK_FIXTURE);
      expect(parsed.spendingCondition?.kind).toBe('P2PK');
      expect(parsed.amount?.toNumber()).toBe(21);

      const runtime = runningRuntime(manager);
      const routes = createRouteHandlers(runtime);
      const response = await routes['/x-cashu/parse']!.POST!(
        postJson('/x-cashu/parse', { request: CREQB_P2PK_FIXTURE }),
      );
      const body = (await response.json()) as { output?: string };
      expect(response.status).toBe(200);
      expect(body.output).toContain('21 Sats');
    } finally {
      await manager.dispose();
    }
  });

  test('/x-cashu/handle rejects unsupported spending conditions before preparing proofs', async () => {
    let prepareCalled = false;
    const manager = {
      paymentRequests: {
        parse: async () => ({
          payableMints: ['https://mint.example.com'],
          allowedMints: [],
          transport: { type: 'inband' },
          spendingCondition: { kind: 'unsupported', nut10Kind: 'HTLC' },
        }),
        prepare: async () => {
          prepareCalled = true;
          throw new Error('should not prepare');
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/handle']!.POST!(
      postJson('/x-cashu/handle', { request: 'creqA-fake' }),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toContain('NUT-10');
    expect(body.error).toContain('HTLC');
    expect(prepareCalled).toBe(false);
  });

  test('/balance reports numeric per-mint totals from the v2 balance snapshots', async () => {
    const manager = {
      wallet: {
        balances: {
          byMint: async () => ({
            'https://mint.example.com': {
              spendable: toAmount(40),
              reserved: toAmount(2),
              total: toAmount(42),
              unit: 'sat',
            },
          }),
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/balance']!.GET!(new Request('http://localhost/balance'));

    const body = (await response.json()) as { output?: Record<string, { sats: number }> };
    expect(response.status).toBe(200);
    expect(body.output).toEqual({ 'https://mint.example.com': { sats: 42 } });
  });

  test('/receive/cashu reports the received amount as a number', async () => {
    let executed = false;
    const manager = {
      ops: {
        receive: {
          prepare: async () => ({ amount: toAmount(5) }),
          execute: async () => {
            executed = true;
          },
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/receive/cashu']!.POST!(
      postJson('/receive/cashu', { token: 'cashuB-fake' }),
    );

    const body = (await response.json()) as { output?: string };
    expect(body.output).toBe('Received 5');
    expect(executed).toBe(true);
  });

  test('/receive/bolt11 creates a canonical quote and prepares the mint operation with it', async () => {
    const createdQuote = { quoteId: 'q1', request: 'lnbc210n1fake' };
    let createInput: unknown;
    let prepareInput: unknown;
    const manager = {
      quotes: {
        mint: {
          create: async (input: unknown) => {
            createInput = input;
            return createdQuote;
          },
        },
      },
      ops: {
        mint: {
          prepare: async (input: unknown) => {
            prepareInput = input;
            return {};
          },
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/receive/bolt11']!.POST!(
      postJson('/receive/bolt11', { amount: 21 }),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toBe('lnbc210n1fake');
    expect(createInput).toEqual({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      amount: 21,
    });
    expect(prepareInput).toEqual({ quote: createdQuote, amount: 21 });
  });

  test('/send/bolt11 creates a canonical melt quote and executes the prepared melt', async () => {
    const createdQuote = { quoteId: 'q2' };
    let createInput: unknown;
    let prepareInput: unknown;
    let executed = false;
    const manager = {
      quotes: {
        melt: {
          create: async (input: unknown) => {
            createInput = input;
            return createdQuote;
          },
        },
      },
      ops: {
        melt: {
          prepare: async (input: unknown) => {
            prepareInput = input;
            return { id: 'op1' };
          },
          execute: async () => {
            executed = true;
          },
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/send/bolt11']!.POST!(
      postJson('/send/bolt11', { invoice: 'lnbc210n1fake' }),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toBe('Paid invoice: lnbc210n1fake');
    expect(createInput).toEqual({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      methodData: { invoice: 'lnbc210n1fake' },
    });
    expect(prepareInput).toEqual({ quote: createdQuote });
    expect(executed).toBe(true);
  });

  test('/x-cashu/handle settles an inband request into an X-Cashu header', async () => {
    const token = {
      mint: 'https://mint.example.com',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: 21,
          secret: 'test-secret',
          C: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
        },
      ],
    };
    const manager = {
      paymentRequests: {
        parse: async () => ({
          payableMints: ['https://mint.example.com'],
          allowedMints: [],
          transport: { type: 'inband' },
        }),
        prepare: async () => ({ id: 'prepared' }),
        execute: async () => ({ type: 'inband', token }),
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/handle']!.POST!(
      postJson('/x-cashu/handle', { request: 'creqA-fake' }),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toStartWith('X-Cashu: cashu');
  });
});
