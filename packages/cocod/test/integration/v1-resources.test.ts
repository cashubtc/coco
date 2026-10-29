import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { PaymentRequest } from '@cashu/cashu-ts';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Amount, initializeCoco, type Manager, type SendOperation } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';

import { AdministrativeCredential, loadClientCredential } from '../../src/credentials.js';
import type { CocodStatus, RunningCocoSession } from '../../src/runtime.js';
import {
  buildV1FallbackHandler,
  buildV1Routes,
  createV1RouteDefinitions,
  type V1Runtime,
} from '../../src/v1/http.js';
import { startFakeMint, type FakeMint } from '../helpers/fake-mint.js';
import { startTcpTestServer } from '../helpers/tcp.js';

// A creqB (TLV + bech32m) payment request for 21 sat carrying a P2PK NUT-10 spending condition,
// generated once with the workspace @cashu/cashu-ts.
const CREQB_P2PK_FIXTURE =
  'CREQB1QYQQ2UN9WYKNZQSQPQQQQQQQQQQQQ9GRQQQSQPQQQYQQ2QQCDP68GURN8GHJ7MTFDE6ZUETCV9KHQMR99E3K7MGXQQX8GETNWSS8QCTED4JKUAQ8QQ0QZQQPQYPQQ9MGW368QUE69UHK27RPD4CXCEFWVDHK6TMSV9USSQZFQYQQZQQZQPPRQVNP89SKXCE3V56RSCEJX4JK2ETZ8YERSWTZX5CRXVTRVV6NWERP89NX2DEJVCEKVEFJ8QMRZEPJXC6XYERRXQMNGV3S893RZVPHVFSNYU24ZDV';

const UNREACHABLE_MINT = 'http://127.0.0.1:1';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function runningStatus(): CocodStatus {
  return {
    wallet: { configuredAt: '2026-10-29T00:00:00.000Z', mintUrl: UNREACHABLE_MINT },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: { state: 'running', startedAt: '2026-10-29T00:00:01.000Z', lastFailure: null },
  } as CocodStatus;
}

interface Harness {
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
  url: string;
  adminCredential: string;
}

async function startHarness(options: { keepAliveMs?: number } = {}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-resources-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const mint = startFakeMint();
  cleanups.push(() => mint.stop());

  const repositories = new SqliteRepositories({ database: new Database(':memory:') });
  const manager = await initializeCoco({
    repo: repositories,
    seedGetter: async () => new Uint8Array(64).fill(7),
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
    routes: buildV1Routes(
      createV1RouteDefinitions(runtime, '0.0.17', shutdown, undefined, {
        eventKeepAliveIntervalMs: options.keepAliveMs ?? 5_000,
      }),
      credentials,
    ),
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

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

function rolledBackSend(mintUrl: string): SendOperation {
  return {
    id: 'send-rolled-back',
    state: 'rolled_back',
    mintUrl,
    amount: Amount.from(5),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 1_000,
    updatedAt: 2_000,
    needsSwap: false,
    fee: Amount.from(0),
    inputAmount: Amount.from(5),
    inputProofSecrets: [],
    token: { mint: mintUrl, proofs: [] },
  } as unknown as SendOperation;
}

describe('v1 Wallet resources over a real Coco Session', () => {
  test('report the lifecycle state that prevents Wallet-dependent work', async () => {
    const harness = await startHarness();
    const cases: Array<
      [CocodStatus['cocoSession']['state'], 'available' | 'locked', number, string]
    > = [
      ['starting', 'available', 503, 'session_transition_in_progress'],
      ['failed', 'available', 503, 'session_restart_required'],
      ['stopped', 'locked', 423, 'wallet_locked'],
      ['stopped', 'available', 503, 'session_stopped'],
    ];
    for (const [state, seed, status, code] of cases) {
      harness.setStatus({
        ...runningStatus(),
        seedAccess: { state: seed, requiresPassphrase: seed === 'locked' },
        cocoSession: { state, startedAt: null, lastFailure: null },
      } as CocodStatus);
      const response = await harness.call('GET', '/v1/balances');
      expect([response.status, (await errorOf(response)).code]).toEqual([status, code]);
    }
  });

  test('register, trust, and describe a Known Mint served by a Mint', async () => {
    const harness = await startHarness();

    const registered = await harness.call('POST', '/v1/mints', {
      body: { mintUrl: `${harness.mint.url}/`, trusted: true },
    });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ mintUrl: harness.mint.url, trusted: true });

    const untrusted = await harness.call('POST', '/v1/mints/untrust', {
      body: { mintUrl: harness.mint.url },
    });
    expect(await untrusted.json()).toMatchObject({ trusted: false });

    // Re-registering without `trusted` preserves the current trust decision.
    const again = await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url } });
    expect(await again.json()).toMatchObject({ trusted: false });

    const all = await harness.call('GET', '/v1/mints');
    const trusted = await harness.call('GET', '/v1/mints?trustedOnly=true');
    expect((await all.json()) as unknown).toMatchObject({ items: [{ mintUrl: harness.mint.url }] });
    expect(await trusted.json()).toEqual({ items: [] });

    const query = `mintUrl=${encodeURIComponent(harness.mint.url)}`;
    const info = await harness.call('GET', `/v1/mints/info?${query}`);
    expect(await info.json()).toMatchObject({
      mintUrl: harness.mint.url,
      info: { name: 'Fake Mint' },
    });

    const capabilities = await harness.call(
      'GET',
      `/v1/mints/payment-method-capabilities?${query}`,
    );
    expect(await capabilities.json()).toEqual({
      mintUrl: harness.mint.url,
      items: [
        {
          operation: 'mint',
          nut: 4,
          method: 'bolt11',
          unit: 'sat',
          minAmount: '1',
          maxAmount: '100000',
        },
        {
          operation: 'melt',
          nut: 5,
          method: 'bolt11',
          unit: 'sat',
          minAmount: null,
          maxAmount: null,
        },
      ],
    });
  });

  test('distinguish unknown Mints from unreachable ones', async () => {
    const harness = await startHarness();

    const trustUnknown = await harness.call('POST', '/v1/mints/trust', {
      body: { mintUrl: 'https://unknown.example.com' },
    });
    expect(trustUnknown.status).toBe(404);
    expect(await harness.manager.mint.getAllMints()).toEqual([]);

    const unreachable = await harness.call('POST', '/v1/mints', {
      body: { mintUrl: UNREACHABLE_MINT },
    });
    expect(unreachable.status).toBe(502);
    expect(unreachable.headers.get('retry-after')).toBe('1');
    expect(await errorOf(unreachable)).toMatchObject({ code: 'mint_unreachable', retryable: true });

    const quote = await harness.call('POST', '/v1/quotes/mint', {
      body: { method: 'bolt11', amount: '10', mintUrl: 'https://unknown.example.com' },
    });
    expect(quote.status).toBe(409);
    expect(await errorOf(quote)).toMatchObject({ code: 'mint_unavailable' });
  });

  test('create a Mint Quote and prepare its Mint Operation without executing it', async () => {
    const harness = await startHarness();
    await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url, trusted: true } });

    const created = await harness.call('POST', '/v1/quotes/mint', {
      body: { method: 'bolt11', amount: '21' },
    });
    expect(created.status).toBe(201);
    const quote = (await created.json()) as Record<string, unknown>;
    expect(quote).toMatchObject({
      type: 'mint',
      mintUrl: harness.mint.url,
      method: 'bolt11',
      amount: '21',
      state: 'UNPAID',
      request: 'lnbc21fake',
    });

    const identity = `${encodeURIComponent(String(quote.quoteId))}?mintUrl=${encodeURIComponent(harness.mint.url)}`;
    const read = await harness.call('GET', `/v1/quotes/mint/${identity}`);
    expect(await read.json()).toEqual(quote);
    const pending = await harness.call('GET', '/v1/quotes/mint/pending?method=bolt11');
    expect(await pending.json()).toMatchObject({ items: [{ quoteId: quote.quoteId }], offset: 0 });

    const prepared = await harness.call('POST', '/v1/operations/mint', {
      body: { mintUrl: harness.mint.url, quoteId: quote.quoteId, amount: '21' },
    });
    expect(prepared.status).toBe(201);
    const operation = (await prepared.json()) as Record<string, unknown>;
    expect(operation).toMatchObject({
      type: 'mint',
      state: 'pending',
      amount: '21',
      quote: { mintUrl: harness.mint.url, quoteId: quote.quoteId },
    });
    expect(JSON.stringify(operation)).not.toContain('outputData');

    const listed = await harness.call('GET', '/v1/operations/mint/pending');
    expect(await listed.json()).toMatchObject({ items: [{ id: operation.id }] });
    expect(harness.mint.requests.filter((request) => request.includes('/v1/mint/'))).toEqual([
      'POST /v1/mint/quote/bolt11',
    ]);
  });

  test('replay an idempotent Quote creation instead of creating a second Quote', async () => {
    const harness = await startHarness();
    await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url, trusted: true } });
    const create = (body: unknown) =>
      harness.call('POST', '/v1/quotes/mint', { body, headers: { 'Idempotency-Key': 'quote-1' } });

    const first = (await (await create({ method: 'bolt11', amount: '5' })).json()) as {
      quoteId: string;
    };
    const replay = (await (await create({ method: 'bolt11', amount: '5' })).json()) as {
      quoteId: string;
    };
    const conflict = await create({ method: 'bolt11', amount: '6' });

    expect(replay.quoteId).toBe(first.quoteId);
    expect(conflict.status).toBe(409);
    expect(await errorOf(conflict)).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(
      harness.mint.requests.filter((request) => request === 'POST /v1/mint/quote/bolt11'),
    ).toHaveLength(1);
  });

  test('map typed Coco lifecycle errors to stable codes with details', async () => {
    const harness = await startHarness();
    await harness.repositories.sendOperationRepository.create(rolledBackSend(harness.mint.url));

    const missing = await harness.call('POST', '/v1/operations/send/missing/cancel');
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({
      code: 'not_found',
      details: { operationType: 'send', operationId: 'missing' },
    });

    const cancel = await harness.call('POST', '/v1/operations/send/send-rolled-back/cancel', {
      body: {},
    });
    expect(cancel.status).toBe(409);
    expect(await errorOf(cancel)).toMatchObject({
      code: 'invalid_operation_state',
      retryable: false,
      details: {
        operationType: 'send',
        operationId: 'send-rolled-back',
        state: 'rolled_back',
        expectedStates: ['prepared'],
      },
    });

    const read = await harness.call('GET', '/v1/operations/send/send-rolled-back');
    expect(await read.json()).toEqual({
      id: 'send-rolled-back',
      type: 'send',
      state: 'rolled_back',
      mintUrl: harness.mint.url,
      method: 'default',
      unit: 'sat',
      amount: '5',
      inputAmount: '5',
      fee: '0',
      needsSwap: false,
      createdAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:02.000Z',
    });

    const result = await harness.call('GET', '/v1/operations/send/send-rolled-back/result');
    expect(result.status).toBe(409);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await errorOf(result)).toMatchObject({ code: 'operation_result_not_available' });
  });

  test('require the admin capability to read a Send token', async () => {
    const harness = await startHarness();
    await harness.repositories.sendOperationRepository.create(rolledBackSend(harness.mint.url));
    const readOnly = await harness.readOnlyCredential();

    const result = await harness.call('GET', '/v1/operations/send/send-rolled-back/result', {
      credential: readOnly,
    });
    const operation = await harness.call('GET', '/v1/operations/send/send-rolled-back', {
      credential: readOnly,
    });

    expect(result.status).toBe(403);
    expect(operation.status).toBe(200);
  });

  test('reject invalid parameters and request bodies before calling Coco', async () => {
    const harness = await startHarness();

    const cases: Array<[string, string, unknown, string | undefined]> = [
      ['GET', '/v1/history?limit=0', undefined, 'limit'],
      ['GET', '/v1/history?limit=1&limit=2', undefined, 'limit'],
      ['GET', '/v1/balances?unexpected=1', undefined, 'unexpected'],
      ['GET', '/v1/history/not-an-entry-id', undefined, 'historyEntryId'],
      ['GET', '/v1/mints/info', undefined, 'mintUrl'],
      ['POST', '/v1/quotes/mint', { method: 'bolt11', amount: '-1' }, undefined],
      ['POST', '/v1/quotes/mint', { method: 'bolt11', amount: '18446744073709551616' }, undefined],
      [
        'POST',
        '/v1/operations/send',
        { source: { type: 'payment-request', request: 'x' }, unit: 'sat' },
        undefined,
      ],
      ['POST', '/v1/mints', { mintUrl: 'ftp://mint.example.com' }, undefined],
    ];
    for (const [method, path, body, parameter] of cases) {
      const response = await harness.call(method as 'GET' | 'POST', path, { body });
      const error = await errorOf(response);
      expect([path, response.status, error.code]).toEqual([path, 400, 'invalid_request']);
      if (parameter) expect(error.details).toEqual({ parameter });
    }
  });

  test('evaluate Payment Requests through Coco without exposing raw details', async () => {
    const harness = await startHarness();

    const evaluated = await harness.call('POST', '/v1/payment-requests/evaluate', {
      body: { request: CREQB_P2PK_FIXTURE },
    });
    expect(evaluated.status).toBe(200);
    expect(await evaluated.json()).toMatchObject({
      amount: '21',
      unit: 'sat',
      transport: { type: 'http' },
      allowedMints: ['https://mint.example.com'],
      payableMints: [],
      spendingCondition: { kind: 'P2PK' },
    });

    const malformed = await harness.call('POST', '/v1/payment-requests/evaluate', {
      body: { request: 'creqAnot-a-request' },
    });
    expect(malformed.status).toBe(400);
    expect(await errorOf(malformed)).toMatchObject({ code: 'invalid_request' });

    const httpTransport = await harness.call('POST', '/v1/operations/send', {
      body: { source: { type: 'payment-request', request: CREQB_P2PK_FIXTURE } },
    });
    expect(httpTransport.status).toBe(409);
    expect(await errorOf(httpTransport)).toMatchObject({
      code: 'unsupported_behavior',
      details: { transport: 'http' },
    });

    const inband = new PaymentRequest([], 'request-1', 100, 'sat', [harness.mint.url]);
    const unpayable = await harness.call('POST', '/v1/operations/send', {
      body: { source: { type: 'payment-request', request: inband.toEncodedRequest() } },
    });
    expect(unpayable.status).toBe(409);
    expect(await errorOf(unpayable)).toMatchObject({ code: 'payment_request_unpayable' });

    const token = await harness.call('POST', '/v1/operations/receive', {
      body: { token: 'cashuBnot-a-token' },
    });
    expect(token.status).toBe(400);
  });

  test('stream Mint invalidations and close the stream when the Coco Session stops', async () => {
    const harness = await startHarness({ keepAliveMs: 20 });
    const response = await harness.call('GET', '/v1/events');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    const readUntil = async (predicate: (text: string) => boolean) => {
      while (!predicate(received)) {
        const { done, value } = await reader.read();
        if (done) return true;
        received += decoder.decode(value, { stream: true });
      }
      return false;
    };

    await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url, trusted: true } });
    await readUntil((text) => text.includes('"type":"mint.updated"'));
    expect(received).toContain(`"mintUrl":"${harness.mint.url}"`);

    harness.setStatus({
      ...runningStatus(),
      cocoSession: { state: 'stopping', startedAt: null, lastFailure: null },
    } as CocodStatus);
    expect(await readUntil(() => false)).toBe(true);
  });
});
