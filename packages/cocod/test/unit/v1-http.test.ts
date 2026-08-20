import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SendOperationStateError, toAmount } from '@cashu/coco-core';

import {
  AdministrativeCredential,
  loadClientCredential,
  type ClientCapability,
} from '../../src/credentials.js';
import type { CocodStatus } from '../../src/runtime.js';
import { ProcessShutdownCoordinator } from '../../src/process-shutdown.js';
import { CocodRuntimeError } from '../../src/runtime-error.js';
import {
  buildV1Routes,
  createV1RouteDefinitions,
  defineV1Route,
  type LifecycleStatusDocument,
  type RuntimeSchema,
  type V1Runtime,
} from '../../src/v1/http.js';
import { deferred } from '../helpers/deferred.js';
import { createTestLogger } from '../helpers/logger.js';
import { createLifecycleTestRouteDefinitions } from '../helpers/v1.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('v1 HTTP route interface', () => {
  test('prepares a safe Send Operation without executing it', async () => {
    const credential = await createCredential();
    const operation = sendOperationFixture();
    const prepare = mock(async () => operation);
    const execute = mock(async () => {
      throw new Error('execute was not expected');
    });
    const routes = createSendTestRoutes(
      { ops: { send: { prepare, execute } } },
      credential.credentials,
    );

    const response = await routes['/v1/operations/send']!.POST!(
      authorizedJsonRequest('/v1/operations/send', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
        amount: '25',
        unit: 'sat',
        forceSwap: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      id: 'send-operation-1',
      type: 'send',
      state: 'prepared',
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      method: 'default',
      requestedAmount: '25',
      inputAmount: '27',
      fee: '2',
      needsSwap: true,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(prepare).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      amount: '25',
      unit: 'sat',
      forceSwap: true,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  test('rejects a blank Send Operation unit as invalid request input', async () => {
    const credential = await createCredential();
    const prepare = mock(async () => sendOperationFixture());
    const routes = createSendTestRoutes({ ops: { send: { prepare } } }, credential.credentials);

    const response = await routes['/v1/operations/send']!.POST!(
      authorizedJsonRequest('/v1/operations/send', credential.plaintext, {
        amount: '25',
        unit: '   ',
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request does not match the expected schema',
        retryable: false,
      },
    });
    expect(prepare).not.toHaveBeenCalled();
  });

  test('inspects a Send Operation without exposing its token or recovery data', async () => {
    const credential = await createCredential();
    const operation = sendOperationFixture({
      state: 'pending' as const,
      token: { mint: 'https://mint.example.com', proofs: [{ secret: 'must-not-leak' }] },
    });
    const get = mock(async () => operation);
    const routes = createSendTestRoutes({ ops: { send: { get } } }, credential.credentials);

    const response = await routes['/v1/operations/send/:operationId']!.GET!(
      authorizedRequest('/v1/operations/send/send-operation-1', credential.plaintext),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'send-operation-1',
      type: 'send',
      state: 'pending',
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      method: 'default',
      requestedAmount: '25',
      inputAmount: '27',
      fee: '2',
      needsSwap: true,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(get).toHaveBeenCalledWith('send-operation-1');
  });

  test('paginates prepared and in-flight Send Operation collections from Coco', async () => {
    const credential = await createCredential();
    const operation = (id: string, createdAt: number, state: 'prepared' | 'pending') =>
      sendOperationFixture({ id, createdAt, updatedAt: createdAt, state });
    const listPrepared = mock(async () => [
      operation('old', 1_786_838_400_000, 'prepared'),
      operation('new-b', 1_786_838_600_000, 'prepared'),
      operation('new-a', 1_786_838_600_000, 'prepared'),
    ]);
    const listInFlight = mock(async () => [operation('pending', 1_786_838_500_000, 'pending')]);
    const routes = createSendTestRoutes(
      { ops: { send: { listPrepared, listInFlight } } },
      credential.credentials,
    );

    const prepared = await routes['/v1/operations/send/prepared']!.GET!(
      authorizedRequest('/v1/operations/send/prepared?offset=1&limit=1', credential.plaintext),
    );
    const inFlight = await routes['/v1/operations/send/in-flight']!.GET!(
      authorizedRequest('/v1/operations/send/in-flight', credential.plaintext),
    );

    expect(await prepared.json()).toMatchObject({
      items: [{ id: 'new-b', state: 'prepared' }],
      offset: 1,
      limit: 1,
    });
    expect(await inFlight.json()).toMatchObject({
      items: [{ id: 'pending', state: 'pending' }],
      offset: 0,
      limit: 20,
    });
    expect(listPrepared).toHaveBeenCalledWith();
    expect(listInFlight).toHaveBeenCalledWith();
  });

  test('executes a Send Operation and returns its sensitive encoded result', async () => {
    const credential = await createCredential();
    const token = { mint: 'https://mint.example.com', proofs: [] };
    const operation = sendOperationFixture({ state: 'pending' as const, token });
    const execute = mock(async () => ({ operation, token }));
    const encodeToken = mock(() => 'cashuBpGF0gaJhaUgA');
    const routes = createSendTestRoutes(
      { ops: { send: { execute } }, wallet: { encodeToken } },
      credential.credentials,
    );

    const response = await routes['/v1/operations/send/:operationId/execute']!.POST!(
      authorizedPostRequest('/v1/operations/send/send-operation-1/execute', credential.plaintext),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      operation: {
        id: 'send-operation-1',
        type: 'send',
        state: 'pending',
        mintUrl: 'https://mint.example.com',
        unit: 'sat',
        method: 'default',
        requestedAmount: '25',
        inputAmount: '27',
        fee: '2',
        needsSwap: true,
        createdAt: '2026-08-16T00:00:00.000Z',
        updatedAt: '2026-08-16T00:01:00.000Z',
      },
      result: { token: 'cashuBpGF0gaJhaUgA' },
    });
    expect(execute).toHaveBeenCalledWith('send-operation-1');
    expect(encodeToken).toHaveBeenCalledWith(token);
  });

  test('recovers an encoded Send result from Coco-owned Operation state', async () => {
    const credential = await createCredential();
    const token = { mint: 'https://mint.example.com', proofs: [] };
    const operation = sendOperationFixture({ state: 'finalized' as const, token });
    const get = mock(async () => operation);
    const execute = mock(async () => {
      throw new Error('execute was not expected');
    });
    const encodeToken = mock(() => 'cashuBrecovered');
    const routes = createSendTestRoutes(
      { ops: { send: { get, execute } }, wallet: { encodeToken } },
      credential.credentials,
    );

    const response = await routes['/v1/operations/send/:operationId/result']!.GET!(
      authorizedRequest('/v1/operations/send/send-operation-1/result', credential.plaintext),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ token: 'cashuBrecovered' });
    expect(get).toHaveBeenCalledWith('send-operation-1');
    expect(execute).not.toHaveBeenCalled();
  });

  test('returns canonical Coco state after Send cancel, refresh, and reclaim commands', async () => {
    const credential = await createCredential();
    const cancel = mock(async () => {});
    const refresh = mock(async () => sendOperationFixture({ state: 'finalized' as const }));
    const reclaim = mock(async () => {});
    const get = mock()
      .mockResolvedValueOnce(sendOperationFixture({ state: 'rolled_back' as const }))
      .mockResolvedValueOnce(sendOperationFixture({ state: 'finalized' as const }))
      .mockResolvedValueOnce(sendOperationFixture({ state: 'rolled_back' as const }));
    const routes = createSendTestRoutes(
      { ops: { send: { cancel, refresh, reclaim, get } } },
      credential.credentials,
    );

    const command = async (name: 'cancel' | 'refresh' | 'reclaim') =>
      routes[`/v1/operations/send/:operationId/${name}`]!.POST!(
        authorizedPostRequest(`/v1/operations/send/send-operation-1/${name}`, credential.plaintext),
      );
    const cancelled = await command('cancel');
    const refreshed = await command('refresh');
    const reclaimed = await command('reclaim');

    expect(await cancelled.json()).toMatchObject({ state: 'rolled_back' });
    expect(await refreshed.json()).toMatchObject({ state: 'finalized' });
    expect(await reclaimed.json()).toMatchObject({ state: 'rolled_back' });
    expect(cancel).toHaveBeenCalledWith('send-operation-1');
    expect(refresh).toHaveBeenCalledWith('send-operation-1');
    expect(reclaim).toHaveBeenCalledWith('send-operation-1');
    expect(get).toHaveBeenCalledTimes(3);
  });

  test('maps Coco typed Send lifecycle failures to an invalid-state conflict', async () => {
    const credential = await createCredential();
    const execute = mock(async () => {
      throw new SendOperationStateError('send-operation-1', 'pending', ['prepared']);
    });
    const routes = createSendTestRoutes({ ops: { send: { execute } } }, credential.credentials);

    const response = await routes['/v1/operations/send/:operationId/execute']!.POST!(
      authorizedPostRequest('/v1/operations/send/send-operation-1/execute', credential.plaintext),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_operation_state',
        message: 'The Send Operation command is unavailable in its current state',
        retryable: false,
        details: {
          type: 'send',
          operationId: 'send-operation-1',
          state: 'pending',
          expectedStates: ['prepared'],
        },
      },
    });
  });

  test('returns a conflict while a Send result is not yet available', async () => {
    const credential = await createCredential();
    const get = mock(async () => sendOperationFixture({ state: 'executing' as const }));
    const routes = createSendTestRoutes({ ops: { send: { get } } }, credential.credentials);

    const response = await routes['/v1/operations/send/:operationId/result']!.GET!(
      authorizedRequest('/v1/operations/send/send-operation-1/result', credential.plaintext),
    );

    expect(response.status).toBe(409);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'operation_result_not_available',
        message: 'The Send Operation result is not available',
        retryable: true,
        details: { state: 'executing' },
      },
    });
  });

  test('replays idempotent Send preparation without creating another Operation', async () => {
    const credential = await createCredential();
    const prepare = mock(async () => sendOperationFixture());
    const routes = createSendTestRoutes({ ops: { send: { prepare } } }, credential.credentials);
    const request = () =>
      authorizedJsonRequest(
        '/v1/operations/send',
        credential.plaintext,
        { mintUrl: 'https://mint.example.com', amount: '25', unit: 'sat' },
        undefined,
        { 'Idempotency-Key': 'prepare-send-1' },
      );

    const first = await routes['/v1/operations/send']!.POST!(request());
    const replay = await routes['/v1/operations/send']!.POST!(request());

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ id: 'send-operation-1' });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  test('authenticates Send Operation resources before calling Coco', async () => {
    const credential = await createCredential();
    const get = mock(async () => sendOperationFixture());
    const routes = createSendTestRoutes({ ops: { send: { get } } }, credential.credentials);

    const response = await routes['/v1/operations/send/:operationId']!.GET!(
      new Request('http://localhost/v1/operations/send/send-operation-1'),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(get).not.toHaveBeenCalled();
  });

  test('maps untyped Coco Send failures without exposing their message', async () => {
    const credential = await createCredential();
    const prepare = mock(async () => {
      throw new Error('proof secret must-not-leak');
    });
    const routes = createSendTestRoutes({ ops: { send: { prepare } } }, credential.credentials);

    const response = await routes['/v1/operations/send']!.POST!(
      authorizedJsonRequest('/v1/operations/send', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        amount: '25',
        unit: 'sat',
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: 'coco_error',
        message: 'Coco could not prepare the Send Operation',
        retryable: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
  });

  test('creates a BOLT11 Mint Quote without preparing an Operation', async () => {
    const credential = await createCredential();
    const quote = mintQuoteFixture({
      blindedSignatures: [{ C_: 'must-not-leak' }],
    });
    const create = mock(async () => quote);
    const routes = createQuoteTestRoutes({ quotes: { mint: { create } } }, credential.credentials);

    const response = await routes['/v1/quotes/mint']!.POST!(
      authorizedJsonRequest('/v1/quotes/mint', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
        method: 'bolt11',
        amount: '25',
        unit: 'sat',
        locked: true,
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      type: 'mint',
      method: 'bolt11',
      mintUrl: 'https://mint.example.com',
      quoteId: 'mint-quote-1',
      request: 'lnbc250n1quote',
      unit: 'sat',
      amount: '25',
      amountPaid: '0',
      amountIssued: '0',
      reusable: false,
      state: 'UNPAID',
      expiry: '2026-08-16T00:05:00.000Z',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(create).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      amount: '25',
      unit: 'sat',
      locked: true,
    });
  });

  test('looks up an evolving Mint Quote by its normalized Coco identity', async () => {
    const credential = await createCredential();
    const quote = mintQuoteFixture({
      quoteId: 'mint-quote-lookup',
      quote: 'mint-quote-lookup',
      request: 'lnbc250n1lookup',
      expiry: null,
      state: 'PAID' as const,
      amountPaid: toAmount(25),
    });
    const get = mock(async () => quote);
    const routes = createQuoteTestRoutes({ quotes: { mint: { get } } }, credential.credentials);

    const response = await routes['/v1/quotes/mint/:quoteId']!.GET!(
      authorizedRequest(
        '/v1/quotes/mint/mint-quote-lookup?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: 'mint',
      quoteId: 'mint-quote-lookup',
      state: 'PAID',
      amountPaid: '25',
    });
    expect(get).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      quoteId: 'mint-quote-lookup',
    });
  });

  test('paginates pending Mint Quotes deterministically after reading them from Coco', async () => {
    const credential = await createCredential();
    const quote = (quoteId: string, mintUrl: string, createdAt: number) =>
      mintQuoteFixture({
        mintUrl,
        quoteId,
        quote: quoteId,
        request: `lnbc1${quoteId}`,
        expiry: null,
        createdAt,
        updatedAt: createdAt,
      });
    const listPending = mock(async () => [
      quote('old', 'https://mint.example.com', 1_786_838_400_000),
      quote('new-b', 'https://mint-b.example.com', 1_786_838_600_000),
      quote('middle', 'https://mint.example.com', 1_786_838_500_000),
      quote('new-a', 'https://mint-a.example.com', 1_786_838_600_000),
    ]);
    const routes = createQuoteTestRoutes(
      { quotes: { mint: { listPending } } },
      credential.credentials,
    );

    const response = await routes['/v1/quotes/mint/pending']!.GET!(
      authorizedRequest(
        '/v1/quotes/mint/pending?method=bolt11&offset=1&limit=2',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ quoteId: 'new-b' }, { quoteId: 'middle' }],
      offset: 1,
      limit: 2,
    });
    expect(listPending).toHaveBeenCalledWith({ method: 'bolt11' });
  });

  test('refreshes a Mint Quote without creating or executing an Operation', async () => {
    const credential = await createCredential();
    const quote = mintQuoteFixture({
      quoteId: 'mint-quote-refresh',
      quote: 'mint-quote-refresh',
      request: 'lnbc250n1refresh',
      expiry: null,
      state: 'PAID' as const,
      amountPaid: toAmount(25),
      remoteUpdatedAt: 1_786_838_460,
    });
    const refresh = mock(async () => quote);
    const routes = createQuoteTestRoutes(
      { quotes: { mint: { get: async () => quote, refresh } } },
      credential.credentials,
    );
    const request = (quoteId = 'mint-quote-refresh') =>
      authorizedPostRequest(
        `/v1/quotes/mint/${quoteId}/refresh?mintUrl=https%3A%2F%2Fmint.example.com%2F`,
        credential.plaintext,
        { 'Idempotency-Key': 'refresh-mint-quote' },
      );

    const first = await routes['/v1/quotes/mint/:quoteId/refresh']!.POST!(request());
    const replay = await routes['/v1/quotes/mint/:quoteId/refresh']!.POST!(request());
    const conflict = await routes['/v1/quotes/mint/:quoteId/refresh']!.POST!(
      request('different-quote'),
    );

    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      quoteId: 'mint-quote-refresh',
      state: 'PAID',
      amountPaid: '25',
    });
    expect(await replay.json()).toMatchObject({ quoteId: 'mint-quote-refresh' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: 'idempotency_key_conflict' },
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      quoteId: 'mint-quote-refresh',
    });
  });

  test('creates a BOLT11 Melt Quote without exposing settlement or blinded fields', async () => {
    const credential = await createCredential();
    const quote = meltQuoteFixture({
      payment_preimage: 'must-not-leak',
      change: [{ C_: 'must-not-leak' }],
      lastObservedRemoteState: 'UNPAID' as const,
      lastObservedRemoteStateAt: 1_786_838_460_000,
    });
    const create = mock(async () => quote);
    const routes = createQuoteTestRoutes({ quotes: { melt: { create } } }, credential.credentials);

    const response = await routes['/v1/quotes/melt']!.POST!(
      authorizedJsonRequest('/v1/quotes/melt', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
        method: 'bolt11',
        invoice: 'lnbc250n1pay',
        amount: '25',
        unit: 'sat',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      type: 'melt',
      method: 'bolt11',
      mintUrl: 'https://mint.example.com',
      quoteId: 'melt-quote-1',
      request: 'lnbc250n1pay',
      unit: 'sat',
      amount: '25',
      feeReserve: '2',
      state: 'UNPAID',
      expiry: '2026-08-16T00:05:00.000Z',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(create).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      methodData: { invoice: 'lnbc250n1pay', amountSats: '25' },
      unit: 'sat',
    });
  });

  test('looks up a Melt Quote by its normalized Coco identity', async () => {
    const credential = await createCredential();
    const quote = meltQuoteFixture({
      quoteId: 'melt-quote-lookup',
      quote: 'melt-quote-lookup',
      request: 'lnbc250n1lookup',
      state: 'PENDING' as const,
    });
    const get = mock(async () => quote);
    const routes = createQuoteTestRoutes({ quotes: { melt: { get } } }, credential.credentials);

    const response = await routes['/v1/quotes/melt/:quoteId']!.GET!(
      authorizedRequest(
        '/v1/quotes/melt/melt-quote-lookup?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      type: 'melt',
      quoteId: 'melt-quote-lookup',
      state: 'PENDING',
    });
    expect(get).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      quoteId: 'melt-quote-lookup',
    });
  });

  test('paginates pending Melt Quotes after reading them from Coco', async () => {
    const credential = await createCredential();
    const quote = (quoteId: string, createdAt: number) =>
      meltQuoteFixture({
        quoteId,
        quote: quoteId,
        request: `lnbc1${quoteId}`,
        createdAt,
        updatedAt: createdAt,
      });
    const listPending = mock(async () => [
      quote('old', 1_786_838_400_000),
      quote('new', 1_786_838_600_000),
      quote('middle', 1_786_838_500_000),
    ]);
    const routes = createQuoteTestRoutes(
      { quotes: { melt: { listPending } } },
      credential.credentials,
    );

    const response = await routes['/v1/quotes/melt/pending']!.GET!(
      authorizedRequest('/v1/quotes/melt/pending?offset=1&limit=1', credential.plaintext),
    );

    expect(await response.json()).toMatchObject({
      items: [{ quoteId: 'middle' }],
      offset: 1,
      limit: 1,
    });
    expect(listPending).toHaveBeenCalledWith();
  });

  test('refreshes a Melt Quote through Coco', async () => {
    const credential = await createCredential();
    const quote = meltQuoteFixture({
      quoteId: 'melt-quote-refresh',
      quote: 'melt-quote-refresh',
      request: 'lnbc250n1refresh',
      state: 'PAID' as const,
      payment_preimage: 'must-not-leak',
    });
    const refresh = mock(async () => quote);
    const routes = createQuoteTestRoutes(
      { quotes: { melt: { get: async () => quote, refresh } } },
      credential.credentials,
    );

    const response = await routes['/v1/quotes/melt/:quoteId/refresh']!.POST!(
      authorizedPostRequest(
        '/v1/quotes/melt/melt-quote-refresh/refresh?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );

    expect(await response.json()).toMatchObject({
      quoteId: 'melt-quote-refresh',
      state: 'PAID',
    });
    expect(refresh).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
      quoteId: 'melt-quote-refresh',
    });
  });

  test('creates reusable onchain and BOLT12 Mint Quote documents', async () => {
    const credential = await createCredential();
    const base = {
      mintUrl: 'https://mint.example.com',
      request: 'payment-request',
      unit: 'sat',
      expiry: null,
      reusable: true as const,
      amountPaid: toAmount(100),
      amountIssued: toAmount(25),
      remoteUpdatedAt: 1_786_838_460,
      createdAt: 1_786_838_400_000,
      updatedAt: 1_786_838_460_000,
    };
    const onchain = {
      ...base,
      method: 'onchain' as const,
      quoteId: 'mint-onchain',
      quote: 'mint-onchain',
      quoteData: { pubkey: 'must-not-leak' },
      pubkey: 'must-not-leak',
    };
    const bolt12 = {
      ...base,
      method: 'bolt12' as const,
      quoteId: 'mint-bolt12',
      quote: 'mint-bolt12',
      amount: toAmount(50),
      quoteData: { pubkey: 'must-not-leak', amount: toAmount(50) },
    };
    const create = mock(async (input: Record<string, unknown> & { method: string }) =>
      input.method === 'onchain' ? onchain : bolt12,
    );
    const routes = createQuoteTestRoutes({ quotes: { mint: { create } } }, credential.credentials);

    const onchainResponse = await routes['/v1/quotes/mint']!.POST!(
      authorizedJsonRequest('/v1/quotes/mint', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'onchain',
        unit: 'sat',
      }),
    );
    const bolt12Response = await routes['/v1/quotes/mint']!.POST!(
      authorizedJsonRequest('/v1/quotes/mint', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'bolt12',
        unit: 'sat',
        amount: '50',
        description: 'coffee',
      }),
    );

    expect(await onchainResponse.json()).toEqual({
      type: 'mint',
      method: 'onchain',
      mintUrl: 'https://mint.example.com',
      quoteId: 'mint-onchain',
      request: 'payment-request',
      unit: 'sat',
      amountPaid: '100',
      amountIssued: '25',
      reusable: true,
      expiry: null,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(await bolt12Response.json()).toMatchObject({
      method: 'bolt12',
      amount: '50',
      reusable: true,
    });
    expect(create.mock.calls.map(([input]) => input)).toEqual([
      { mintUrl: 'https://mint.example.com', method: 'onchain', unit: 'sat' },
      {
        mintUrl: 'https://mint.example.com',
        method: 'bolt12',
        unit: 'sat',
        amount: '50',
        description: 'coffee',
      },
    ]);
  });

  test('creates BOLT12 and onchain Melt Quote documents with safe fee terms', async () => {
    const credential = await createCredential();
    const base = {
      mintUrl: 'https://mint.example.com',
      request: 'payment-target',
      amount: toAmount(75),
      unit: 'sat',
      expiry: 1_786_838_700,
      state: 'UNPAID' as const,
      createdAt: 1_786_838_400_000,
      updatedAt: 1_786_838_460_000,
    };
    const bolt12 = {
      ...base,
      method: 'bolt12' as const,
      quoteId: 'melt-bolt12',
      quote: 'melt-bolt12',
      fee_reserve: toAmount(3),
      payment_preimage: 'must-not-leak',
    };
    const onchain = {
      ...base,
      method: 'onchain' as const,
      quoteId: 'melt-onchain',
      quote: 'melt-onchain',
      fee_options: [{ fee_index: 4, fee_reserve: toAmount(8), estimated_blocks: 2 }],
      outpoint: 'must-not-leak',
      change: [{ C_: 'must-not-leak' }],
    };
    const create = mock(async (input: Record<string, unknown> & { method: string }) =>
      input.method === 'bolt12' ? bolt12 : onchain,
    );
    const routes = createQuoteTestRoutes({ quotes: { melt: { create } } }, credential.credentials);

    const bolt12Response = await routes['/v1/quotes/melt']!.POST!(
      authorizedJsonRequest('/v1/quotes/melt', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'bolt12',
        offer: 'lno1offer',
        amount: '75',
        unit: 'sat',
      }),
    );
    const onchainResponse = await routes['/v1/quotes/melt']!.POST!(
      authorizedJsonRequest('/v1/quotes/melt', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'onchain',
        address: 'bc1qaddress',
        amount: '75',
        unit: 'sat',
      }),
    );

    expect(await bolt12Response.json()).toMatchObject({
      method: 'bolt12',
      feeReserve: '3',
    });
    expect(await onchainResponse.json()).toEqual({
      type: 'melt',
      method: 'onchain',
      mintUrl: 'https://mint.example.com',
      quoteId: 'melt-onchain',
      request: 'payment-target',
      unit: 'sat',
      amount: '75',
      feeOptions: [{ feeIndex: 4, feeReserve: '8', estimatedBlocks: 2 }],
      state: 'UNPAID',
      expiry: '2026-08-16T00:05:00.000Z',
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(create.mock.calls.map(([input]) => input)).toEqual([
      {
        mintUrl: 'https://mint.example.com',
        method: 'bolt12',
        methodData: { offer: 'lno1offer', amountSats: '75' },
        unit: 'sat',
      },
      {
        mintUrl: 'https://mint.example.com',
        method: 'onchain',
        methodData: { address: 'bc1qaddress', amountSats: '75' },
        unit: 'sat',
      },
    ]);
  });

  test('returns a typed unsupported error for unavailable Quote methods', async () => {
    const credential = await createCredential();
    const create = mock(async () => {
      throw new Error('Coco should not be called');
    });
    const routes = createQuoteTestRoutes(
      { quotes: { mint: { create }, melt: { create } } },
      credential.credentials,
    );

    const mintResponse = await routes['/v1/quotes/mint']!.POST!(
      authorizedJsonRequest('/v1/quotes/mint', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'custom',
        amount: '25',
        unit: 'sat',
      }),
    );
    const meltResponse = await routes['/v1/quotes/melt']!.POST!(
      authorizedJsonRequest('/v1/quotes/melt', credential.plaintext, {
        mintUrl: 'https://mint.example.com',
        method: 'custom',
        invoice: 'lnbc250n1pay',
        amount: '25',
        unit: 'sat',
      }),
    );

    expect(mintResponse.status).toBe(409);
    expect(await mintResponse.json()).toMatchObject({
      error: {
        code: 'unsupported_behavior',
        retryable: false,
        details: { type: 'mint', method: 'custom' },
      },
    });
    expect(meltResponse.status).toBe(409);
    expect(await meltResponse.json()).toMatchObject({
      error: {
        code: 'unsupported_behavior',
        retryable: false,
        details: { type: 'melt', method: 'custom' },
      },
    });
    expect(create).not.toHaveBeenCalled();
  });

  test('returns not found before refreshing an absent Quote', async () => {
    const credential = await createCredential();
    const get = mock(async () => null);
    const refresh = mock(async () => {
      throw new Error('refresh should not run');
    });
    const routes = createQuoteTestRoutes(
      { quotes: { mint: { get, refresh } } },
      credential.credentials,
    );

    const response = await routes['/v1/quotes/mint/:quoteId/refresh']!.POST!(
      authorizedPostRequest(
        '/v1/quotes/mint/missing/refresh?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(refresh).not.toHaveBeenCalled();
  });

  test('authenticates Quote resources before calling Coco', async () => {
    const credential = await createCredential();
    const create = mock(async () => {
      throw new Error('Coco should not be called');
    });
    const routes = createQuoteTestRoutes({ quotes: { mint: { create } } }, credential.credentials);

    const response = await routes['/v1/quotes/mint']!.POST!(
      new Request('http://localhost/v1/quotes/mint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mintUrl: 'https://mint.example.com',
          method: 'bolt11',
          amount: '25',
          unit: 'sat',
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    expect(create).not.toHaveBeenCalled();
  });

  test('rejects malformed Quote identities and pagination before calling Coco', async () => {
    const credential = await createCredential();
    const get = mock(async () => null);
    const listPending = mock(async () => []);
    const routes = createQuoteTestRoutes(
      { quotes: { mint: { get, listPending } } },
      credential.credentials,
    );

    const missingMintUrl = await routes['/v1/quotes/mint/:quoteId']!.GET!(
      authorizedRequest('/v1/quotes/mint/quote-1', credential.plaintext),
    );
    const invalidQuoteId = await routes['/v1/quotes/mint/:quoteId']!.GET!(
      authorizedRequest(
        '/v1/quotes/mint/quote%2F1?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );
    const invalidPage = await routes['/v1/quotes/mint/pending']!.GET!(
      authorizedRequest('/v1/quotes/mint/pending?offset=-1&limit=101', credential.plaintext),
    );

    expect([missingMintUrl.status, invalidQuoteId.status, invalidPage.status]).toEqual([
      400, 400, 400,
    ]);
    expect(get).not.toHaveBeenCalled();
    expect(listPending).not.toHaveBeenCalled();
  });

  test('returns not found for an absent singular Quote', async () => {
    const credential = await createCredential();
    const get = mock(async () => null);
    const routes = createQuoteTestRoutes({ quotes: { melt: { get } } }, credential.credentials);

    const response = await routes['/v1/quotes/melt/:quoteId']!.GET!(
      authorizedRequest(
        '/v1/quotes/melt/missing?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  test('maps Coco Quote failures without exposing their diagnostic text', async () => {
    const credential = await createCredential();
    const listPending = mock(async () => {
      throw new Error('private mint diagnostic');
    });
    const routes = createQuoteTestRoutes(
      { quotes: { melt: { listPending } } },
      credential.credentials,
    );

    const response = await routes['/v1/quotes/melt/pending']!.GET!(
      authorizedRequest('/v1/quotes/melt/pending', credential.plaintext),
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({ error: { code: 'coco_error', retryable: false } });
    expect(JSON.stringify(body)).not.toContain('private mint diagnostic');
  });

  test('registers a normalized Known Mint without granting trust', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const addMint = mock(async (mintUrl: string, options?: { trusted?: boolean }) => ({
      mint,
      keysets: [],
      created: true,
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { addMint, getAllMints: async () => [mint] } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints']!.POST!(
      authorizedJsonRequest('/v1/mints', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      trusted: false,
      createdAt: '2026-08-16T00:00:00.000Z',
      updatedAt: '2026-08-16T00:01:00.000Z',
    });
    expect(addMint).toHaveBeenCalledWith('https://mint.example.com');
  });

  test('lists Known Mints and preserves trust on duplicate registration', async () => {
    const credential = await createCredential();
    const knownMint = {
      mintUrl: 'https://mint.example.com/',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: true,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const getAllMints = mock(async () => [knownMint]);
    const getAllTrustedMints = mock(async () => [knownMint]);
    const addMint = mock(async () => ({ mint: knownMint, keysets: [], created: false }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { addMint, getAllMints, getAllTrustedMints } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const listed = await routes['/v1/mints']!.GET!(
      authorizedRequest('/v1/mints?trustedOnly=true', credential.plaintext),
    );
    const duplicate = await routes['/v1/mints']!.POST!(
      authorizedJsonRequest('/v1/mints', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );

    expect(await listed.json()).toEqual({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          name: 'Example Mint',
          trusted: true,
          createdAt: '2026-08-16T00:00:00.000Z',
          updatedAt: '2026-08-16T00:01:00.000Z',
        },
      ],
    });
    expect(getAllTrustedMints).toHaveBeenCalledTimes(1);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      mintUrl: 'https://mint.example.com',
      trusted: true,
    });
    expect(addMint).toHaveBeenCalledWith('https://mint.example.com');
  });

  test('uses Coco registration results for concurrent creation status', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    let registrations = 0;
    const addMint = mock(async () => ({
      mint,
      keysets: [],
      created: registrations++ === 0,
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({ manager: { mint: { addMint } } }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );
    const register = () =>
      routes['/v1/mints']!.POST!(
        authorizedJsonRequest('/v1/mints', credential.plaintext, {
          mintUrl: mint.mintUrl,
        }),
      );

    const responses = await Promise.all([register(), register()]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(addMint).toHaveBeenCalledTimes(2);
  });

  test('changes trust only through explicit authenticated commands', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: { name: 'Example Mint' },
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    const getAllMints = mock(async () => [mint]);
    const trustMint = mock(async () => {
      mint.trusted = true;
    });
    const untrustMint = mock(async () => {
      mint.trusted = false;
    });
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { mint: { getAllMints, trustMint, untrustMint } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/mints/trust']!.POST!(
      new Request('http://localhost/v1/mints/trust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mintUrl: mint.mintUrl }),
      }),
    );
    const trusted = await routes['/v1/mints/trust']!.POST!(
      authorizedJsonRequest('/v1/mints/trust', credential.plaintext, {
        mintUrl: 'https://mint.example.com/',
      }),
    );
    const untrusted = await routes['/v1/mints/untrust']!.POST!(
      authorizedJsonRequest('/v1/mints/untrust', credential.plaintext, {
        mintUrl: mint.mintUrl,
      }),
    );

    expect(unauthenticated.status).toBe(401);
    expect(trustMint).toHaveBeenCalledWith('https://mint.example.com');
    expect(await trusted.json()).toMatchObject({ trusted: true });
    expect(untrustMint).toHaveBeenCalledWith('https://mint.example.com');
    expect(await untrusted.json()).toMatchObject({ trusted: false });
  });

  test('does not synthesize Known Mint state when the post-trust Coco read is missing', async () => {
    const credential = await createCredential();
    const mint = {
      mintUrl: 'https://mint.example.com',
      name: 'Example Mint',
      mintInfo: {},
      trusted: false,
      createdAt: 1_786_838_400,
      updatedAt: 1_786_838_460,
    };
    let reads = 0;
    const getAllMints = mock(async () => (reads++ === 0 ? [mint] : []));
    const trustMint = mock(async () => undefined);
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({ manager: { mint: { getAllMints, trustMint } } }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints/trust']!.POST!(
      authorizedJsonRequest('/v1/mints/trust', credential.plaintext, {
        mintUrl: mint.mintUrl,
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'coco_error' } });
  });

  test('returns refreshed Mint information and safely maps refresh failures', async () => {
    const credential = await createCredential();
    const getMintInfo = mock(async () => ({
      name: 'Example Mint',
      description: 'Fresh metadata',
      nuts: { '4': { disabled: false, methods: [] } },
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            getAllMints: async () => [
              {
                mintUrl: 'https://mint.example.com',
                name: 'Example Mint',
                trusted: false,
                createdAt: 1_786_838_400,
                updatedAt: 1_786_838_460,
              },
            ],
            getMintInfo,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints/info']!.GET!(
      authorizedRequest(
        '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(await response.json()).toEqual({
      mintUrl: 'https://mint.example.com',
      info: {
        name: 'Example Mint',
        description: 'Fresh metadata',
        nuts: { '4': { disabled: false, methods: [] } },
      },
    });
    expect(getMintInfo).toHaveBeenCalledWith('https://mint.example.com');

    getMintInfo.mockImplementation(async () => {
      throw new Error('https://mint.example.com/private?token=secret');
    });
    const failed = await routes['/v1/mints/info']!.GET!(
      authorizedRequest(
        '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.example.com',
        credential.plaintext,
      ),
    );
    const failureDocument = await failed.json();
    expect(failed.status).toBe(500);
    expect(failureDocument).toMatchObject({
      error: { code: 'coco_error', retryable: false },
    });
    expect(JSON.stringify(failureDocument)).not.toContain('token=secret');
  });

  test('lists lossless payment-method capabilities for a Known Mint', async () => {
    const credential = await createCredential();
    const listPaymentMethodCapabilities = mock(async () => [
      {
        operation: 'mint' as const,
        nut: 4 as const,
        method: 'bolt11',
        unit: 'sat',
        minAmount: toAmount(9_007_199_254_740_993n),
        maxAmount: null,
        options: { reusable: true },
      },
    ]);
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            getAllMints: async () => [
              {
                mintUrl: 'https://mint.example.com',
                name: 'Example Mint',
                trusted: false,
                createdAt: 1_786_838_400,
                updatedAt: 1_786_838_460,
              },
            ],
            listPaymentMethodCapabilities,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/mints/payment-method-capabilities']!.GET!(
      authorizedRequest(
        '/v1/mints/payment-method-capabilities?mintUrl=https%3A%2F%2Fmint.example.com%2F',
        credential.plaintext,
      ),
    );

    expect(await response.json()).toEqual({
      items: [
        {
          operation: 'mint',
          nut: 4,
          method: 'bolt11',
          unit: 'sat',
          minAmount: '9007199254740993',
          maxAmount: null,
          options: { reusable: true },
        },
      ],
    });
    expect(listPaymentMethodCapabilities).toHaveBeenCalledWith({
      mintUrl: 'https://mint.example.com',
    });
  });

  test('rejects invalid Mint requests and unknown trust targets before mutation', async () => {
    const credential = await createCredential();
    const addMint = mock(async () => {
      throw new Error('must not register invalid input');
    });
    const trustMint = mock(async () => {
      throw new Error('must not trust unknown input');
    });
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          mint: {
            addMint,
            getAllMints: async () => [],
            getAllTrustedMints: async () => [],
            getMintInfo: async () => ({}),
            listPaymentMethodCapabilities: async () => [],
            trustMint,
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const invalidRequests = [
      routes['/v1/mints']!.POST!(
        authorizedJsonRequest('/v1/mints', credential.plaintext, { mintUrl: 'ftp://mint.test' }),
      ),
      routes['/v1/mints']!.GET!(
        authorizedRequest('/v1/mints?trustedOnly=yes', credential.plaintext),
      ),
      routes['/v1/mints/info']!.GET!(
        authorizedRequest(
          '/v1/mints/info?mintUrl=https%3A%2F%2Fmint.test&extra=1',
          credential.plaintext,
        ),
      ),
      routes['/v1/mints/payment-method-capabilities']!.GET!(
        authorizedRequest(
          '/v1/mints/payment-method-capabilities?mintUrl=https%3A%2F%2Fmint.test&operation=mint',
          credential.plaintext,
        ),
      ),
    ];

    for (const pending of invalidRequests) {
      const response = await pending;
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', retryable: false },
      });
    }

    const unknown = await routes['/v1/mints/trust']!.POST!(
      authorizedJsonRequest('/v1/mints/trust', credential.plaintext, {
        mintUrl: 'https://unknown.example.com',
      }),
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(addMint).not.toHaveBeenCalled();
    expect(trustMint).not.toHaveBeenCalled();
  });

  test('returns filtered balances as lossless flat v1 resources', async () => {
    const credential = await createCredential();
    const byMintAndUnit = mock(async () => ({
      'https://mint.example.com': {
        sat: {
          spendable: toAmount(9_007_199_254_740_993n),
          reserved: toAmount(7),
          total: toAmount(9_007_199_254_741_000n),
          unit: 'sat',
        },
        usd: {
          spendable: toAmount(2),
          reserved: toAmount(1),
          total: toAmount(3),
          unit: 'usd',
        },
      },
    }));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { wallet: { balances: { byMintAndUnit } } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/balances']!.GET!(
      new Request('http://localhost/v1/balances'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(await unauthenticated.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });
    expect(byMintAndUnit).not.toHaveBeenCalled();

    const response = await routes['/v1/balances']!.GET!(
      authorizedRequest(
        '/v1/balances?mintUrl=https%3A%2F%2Fmint.example.com&mintUrl=https%3A%2F%2Fmint.other&unit=sat&unit=usd&trustedOnly=true',
        credential.plaintext,
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        {
          mintUrl: 'https://mint.example.com',
          unit: 'sat',
          spendable: '9007199254740993',
          reserved: '7',
          total: '9007199254741000',
        },
        {
          mintUrl: 'https://mint.example.com',
          unit: 'usd',
          spendable: '2',
          reserved: '1',
          total: '3',
        },
      ],
    });
    expect(byMintAndUnit).toHaveBeenCalledWith({
      mintUrls: ['https://mint.example.com', 'https://mint.other'],
      units: ['sat', 'usd'],
      trustedOnly: true,
    });
  });

  test('returns a safe v1 error when Coco cannot read balances', async () => {
    const credential = await createCredential();
    const unsafeDiagnostic = 'postgres://owner:secret@wallet-db';
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: {
          wallet: {
            balances: {
              byMintAndUnit: async () => {
                throw new Error(unsafeDiagnostic);
              },
            },
          },
        },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/balances']!.GET!(
      authorizedRequest('/v1/balances', credential.plaintext),
    );
    const document = await response.json();

    expect(response.status).toBe(500);
    expect(document).toEqual({
      error: {
        code: 'coco_error',
        message: 'Coco could not return Wallet balances',
        retryable: false,
      },
    });
    expect(JSON.stringify(document)).not.toContain(unsafeDiagnostic);
  });

  test('rejects invalid balance filters before calling Coco', async () => {
    const credential = await createCredential();
    const byMintAndUnit = mock(async () => ({}));
    const runtime = {
      ...lifecycleRuntime(() => configuredStatus('running')),
      getRunningSession: () => ({
        manager: { wallet: { balances: { byMintAndUnit } } },
      }),
    } as unknown as V1Runtime;
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    for (const query of [
      'trustedOnly=yes',
      'trustedOnly=true&trustedOnly=false',
      'mintUrl=not-a-url',
      'mintUrl=ftp%3A%2F%2Fmint.example.com',
      'unit=',
      'unexpected=sat',
    ]) {
      const response = await routes['/v1/balances']!.GET!(
        authorizedRequest(`/v1/balances?${query}`, credential.plaintext),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { code: 'invalid_request', retryable: false },
      });
    }
    expect(byMintAndUnit).not.toHaveBeenCalled();
  });

  test('maps every inactive Coco Session state to its shared v1 error', async () => {
    const credential = await createCredential();
    const cases: Array<{
      status: CocodStatus;
      httpStatus: number;
      code: string;
      retryable: boolean;
      retryAfter?: string;
    }> = [
      {
        status: unconfiguredStatus(),
        httpStatus: 409,
        code: 'wallet_not_configured',
        retryable: false,
      },
      {
        status: configuredStatus('starting'),
        httpStatus: 503,
        code: 'session_transition_in_progress',
        retryable: true,
        retryAfter: '1',
      },
      {
        status: configuredStatus('stopping'),
        httpStatus: 503,
        code: 'session_transition_in_progress',
        retryable: true,
        retryAfter: '1',
      },
      {
        status: configuredStatus('failed'),
        httpStatus: 503,
        code: 'session_restart_required',
        retryable: false,
      },
      {
        status: {
          ...configuredStatus('stopped'),
          seedAccess: { state: 'locked', requiresPassphrase: true },
        },
        httpStatus: 423,
        code: 'wallet_locked',
        retryable: false,
      },
      {
        status: configuredStatus('stopped'),
        httpStatus: 503,
        code: 'session_stopped',
        retryable: true,
      },
    ];

    for (const testCase of cases) {
      const runtime = lifecycleRuntime(() => testCase.status);
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
        credential.credentials,
      );

      const response = await routes['/v1/balances']!.GET!(
        authorizedRequest('/v1/balances', credential.plaintext),
      );

      expect(response.status).toBe(testCase.httpStatus);
      expect(response.headers.get('retry-after')).toBe(testCase.retryAfter ?? null);
      expect(await response.json()).toMatchObject({
        error: { code: testCase.code, retryable: testCase.retryable },
      });
    }
  });

  test('declares implemented v1 routes with their runtime schemas and capabilities', () => {
    const routes = createLifecycleTestRouteDefinitions(
      statusRuntime(unconfiguredStatus()),
      '0.0.17',
    );

    expect(
      routes.map(
        ({
          method,
          path,
          capability,
          requestSchema,
          responseSchema,
          successStatuses,
          idempotencyKey,
          responseCacheControl,
        }) => ({
          method,
          path,
          capability,
          requestSchema: requestSchema.name,
          responseSchema: responseSchema.name,
          successStatuses,
          idempotencyKey,
          responseCacheControl,
        }),
      ),
    ).toEqual([
      {
        method: 'GET',
        path: '/health',
        capability: null,
        requestSchema: 'NoBody',
        responseSchema: 'Health',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/status',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/balances',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'Balances',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'KnownMints',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200, 201],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints/trust',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/mints/untrust',
        capability: 'wallet:admin',
        requestSchema: 'MintUrlRequest',
        responseSchema: 'KnownMint',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints/info',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'MintInformation',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/mints/payment-method-capabilities',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'PaymentMethodCapabilities',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/quotes/mint',
        capability: 'wallet:admin',
        requestSchema: 'CreateMintQuoteRequest',
        responseSchema: 'MintQuote',
        successStatuses: [201],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/quotes/mint/pending',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'PendingMintQuotes',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/quotes/mint/{quoteId}',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'MintQuote',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/quotes/mint/{quoteId}/refresh',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'MintQuote',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/quotes/melt',
        capability: 'wallet:admin',
        requestSchema: 'CreateMeltQuoteRequest',
        responseSchema: 'MeltQuote',
        successStatuses: [201],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/quotes/melt/pending',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'PendingMeltQuotes',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/quotes/melt/{quoteId}',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'MeltQuote',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/quotes/melt/{quoteId}/refresh',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'MeltQuote',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/operations/send',
        capability: 'wallet:admin',
        requestSchema: 'CreateSendOperationRequest',
        responseSchema: 'SendOperation',
        successStatuses: [201],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/operations/send/prepared',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperations',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/operations/send/in-flight',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperations',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'GET',
        path: '/v1/operations/send/{operationId}',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperation',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/operations/send/{operationId}/execute',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'ExecuteSendOperationResponse',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: 'no-store',
      },
      {
        method: 'GET',
        path: '/v1/operations/send/{operationId}/result',
        capability: 'wallet:read',
        requestSchema: 'NoBody',
        responseSchema: 'SendResult',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: 'no-store',
      },
      {
        method: 'POST',
        path: '/v1/operations/send/{operationId}/cancel',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperation',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/operations/send/{operationId}/refresh',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperation',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/operations/send/{operationId}/reclaim',
        capability: 'wallet:admin',
        requestSchema: 'NoBody',
        responseSchema: 'SendOperation',
        successStatuses: [200],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/wallet/initialize',
        capability: 'wallet:admin',
        requestSchema: 'InitializeWalletRequest',
        responseSchema: 'InitializeWalletResponse',
        successStatuses: [201, 202],
        idempotencyKey: 'optional',
        responseCacheControl: 'no-store',
      },
      {
        method: 'POST',
        path: '/v1/admin/wallet/recovery-material',
        capability: 'wallet:admin',
        requestSchema: 'WalletRecoveryMaterialRequest',
        responseSchema: 'WalletRecoveryMaterialResponse',
        successStatuses: [200],
        idempotencyKey: null,
        responseCacheControl: 'no-store',
      },
      {
        method: 'POST',
        path: '/v1/admin/session/start',
        capability: 'wallet:admin',
        requestSchema: 'StartSessionRequest',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200, 202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/session/stop',
        capability: 'wallet:admin',
        requestSchema: 'StopSessionRequest',
        responseSchema: 'LifecycleStatus',
        successStatuses: [200, 202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
      {
        method: 'POST',
        path: '/v1/admin/process/stop',
        capability: 'wallet:admin',
        requestSchema: 'ProcessShutdownRequest',
        responseSchema: 'ProcessShutdownResponse',
        successStatuses: [202],
        idempotencyKey: 'optional',
        responseCacheControl: null,
      },
    ]);
  });

  test('authenticates and accepts Cocod Process shutdown', async () => {
    const credential = await createCredential();
    const requestShutdown = mock(async (_reason: 'http_stop') => 0);
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', {
        request: requestShutdown,
      }),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/admin/process/stop']!.POST!(
      new Request('http://localhost/v1/admin/process/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    );
    const accepted = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );

    expect(unauthenticated.status).toBe(401);
    expect(requestShutdown).toHaveBeenCalledTimes(1);
    expect(requestShutdown).toHaveBeenCalledWith('http_stop');
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ status: 'stopping' });
  });

  test('rejects new v1 work after shutdown acceptance while replaying stop acceptance', async () => {
    const credential = await createCredential();
    let acceptingWork = true;
    const requestShutdown = mock(async (_reason: 'http_stop') => {
      acceptingWork = false;
      return 0;
    });
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', {
        request: requestShutdown,
      }),
      credential.credentials,
      undefined,
      { isAcceptingWork: () => acceptingWork },
    );

    const accepted = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );
    const rejected = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );
    const concurrent = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}),
    );

    expect(accepted.status).toBe(202);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      error: { code: 'process_shutting_down', retryable: false },
    });
    expect(concurrent.status).toBe(202);
    expect(await concurrent.json()).toEqual({ status: 'stopping' });
  });

  test('continues an accepted shutdown after the initiating client disconnects', async () => {
    const credential = await createCredential();
    const listenerClosed = deferred<void>();
    const exit = mock((_code: number) => {});
    const shutdown = new ProcessShutdownCoordinator({
      closeListener: () => listenerClosed.promise,
      disposeRuntime: async () => {},
      cleanupProcessState: async () => {},
      flushLogs: async () => {},
      reportFailure: () => {},
      exit,
      logger: createTestLogger(),
    });
    const routes = buildV1Routes(
      createV1RouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17', shutdown),
      credential.credentials,
    );
    const controller = new AbortController();

    const response = await routes['/v1/admin/process/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/process/stop', credential.plaintext, {}, controller.signal),
    );
    controller.abort();
    listenerClosed.resolve();

    expect(response.status).toBe(202);
    expect(await shutdown.request('http_stop')).toBe(0);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('returns the documented status resource in every Coco Session state', async () => {
    const credential = await createCredential();
    const states = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const;

    for (const state of states) {
      const status = configuredStatus(state);
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(statusRuntime(status), '0.0.17'),
        credential.credentials,
      );
      const response = await routes['/v1/status']!.GET!(
        authorizedRequest('/v1/status', credential.plaintext),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toStartWith('application/json');
      expect(response.headers.get('x-request-id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(await response.json()).toEqual({
        daemon: { version: '0.0.17', interfaceVersion: '1' },
        wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
        seedAccess: { state: 'available', requiresPassphrase: false },
        cocoSession: {
          state,
          startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
          lastFailure:
            state === 'failed'
              ? {
                  code: 'session_start_failed',
                  message: 'Coco Session failed to start',
                  occurredAt: '2026-08-16T00:00:02.000Z',
                }
              : null,
        },
      });
    }
  });

  test('returns null Wallet and Seed Access when no Wallet is configured', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('returns a configured Wallet with locked Seed Access and no running session', async () => {
    const credential = await createCredential();
    const status: CocodStatus = {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(status), '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );

    expect(await response.json()).toEqual({
      daemon: { version: '0.0.17', interfaceVersion: '1' },
      wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
  });

  test('initializes only host-generated Wallets with non-cacheable transition responses', async () => {
    const credential = await createCredential();
    const generatedMnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

    for (const request of [
      { body: { passphrase: 'correct horse' }, status: 201, state: 'stopped' as const },
      { body: {}, status: 202, state: 'starting' as const },
    ]) {
      let status = unconfiguredStatus();
      const initializeWallet = mock(async (input: { passphrase?: string }) => {
        const requiresPassphrase = Boolean(input.passphrase);
        status = {
          wallet: {
            configuredAt: '2026-08-16T00:00:00.000Z',
            mintUrl: 'https://mint.example.com',
          },
          seedAccess: {
            state: requiresPassphrase ? 'locked' : 'available',
            requiresPassphrase,
          },
          cocoSession: { state: request.state, startedAt: null, lastFailure: null },
        };
        return { mnemonic: generatedMnemonic, requiresPassphrase };
      });
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(
          lifecycleRuntime(() => status, { initializeWallet }),
          '0.0.17',
        ),
        credential.credentials,
      );

      const response = await routes['/v1/admin/wallet/initialize']!.POST!(
        authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, request.body),
      );

      expect(response.status).toBe(request.status);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({
        generatedMnemonic,
        status: {
          daemon: { version: '0.0.17', interfaceVersion: '1' },
          wallet: { configuredAt: '2026-08-16T00:00:00.000Z' },
          seedAccess: status.seedAccess,
          cocoSession: status.cocoSession,
        },
      });
      expect(initializeWallet).toHaveBeenCalledWith(request.body);
    }

    const initializeWallet = mock(async () => ({
      mnemonic: generatedMnemonic,
      requiresPassphrase: false,
    }));
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(unconfiguredStatus, { initializeWallet }),
        '0.0.17',
      ),
      credential.credentials,
    );
    const importAttempt = await routes['/v1/admin/wallet/initialize']!.POST!(
      authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, {
        mnemonic: generatedMnemonic,
      }),
    );
    expect(importAttempt.status).toBe(400);
    expect(initializeWallet).not.toHaveBeenCalled();
  });

  test('retrieves Wallet Recovery Material repeatably with a non-cacheable response', async () => {
    const credential = await createCredential();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const status = configuredStatus('failed');
    const getWalletRecoveryMaterial = mock(async () => mnemonic);
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => status, { getWalletRecoveryMaterial }),
        '0.0.17',
      ),
      credential.credentials,
    );

    for (let retrieval = 0; retrieval < 2; retrieval += 1) {
      const response = await routes['/v1/admin/wallet/recovery-material']!.POST!(
        authorizedJsonRequest(
          '/v1/admin/wallet/recovery-material',
          credential.plaintext,
          { passphrase: 'correct horse' },
          undefined,
          { 'Idempotency-Key': 'not-required-for-retrieval' },
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toEqual({ mnemonic });
      expect(status.cocoSession.state).toBe('failed');
    }
    expect(getWalletRecoveryMaterial).toHaveBeenCalledTimes(2);
    expect(getWalletRecoveryMaterial).toHaveBeenCalledWith({ passphrase: 'correct horse' });
  });

  test('protects recovery retrieval and keeps request and response secrets out of logs', async () => {
    const credential = await createCredential();
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const correctPassphrase = 'correct horse battery staple';
    const wrongPassphrase = 'wrong secret passphrase';
    const getWalletRecoveryMaterial = mock(async ({ passphrase }: { passphrase?: string }) => {
      if (!passphrase) {
        throw new CocodRuntimeError('passphrase_required', 'unsafe missing-passphrase detail');
      }
      if (passphrase !== correctPassphrase) {
        throw new CocodRuntimeError('wallet_unlock_failed', `unsafe ${passphrase}`);
      }
      return mnemonic;
    });
    const debug = mock((_event: string, _fields?: unknown) => {});
    const info = mock((_event: string, _fields?: unknown) => {});
    const warn = mock((_event: string, _fields?: unknown) => {});
    const error = mock((_event: string, _fields?: unknown) => {});
    const logger = createTestLogger({ debug, info, warn, error });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => configuredStatus('running'), { getWalletRecoveryMaterial }),
        '0.0.17',
      ),
      credential.credentials,
      logger,
    );
    const recoveryRoute = routes['/v1/admin/wallet/recovery-material']!.POST!;

    const unauthenticated = await recoveryRoute(
      new Request('http://localhost/v1/admin/wallet/recovery-material', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passphrase: correctPassphrase }),
      }),
    );
    expect(unauthenticated.status).toBe(401);
    expect(getWalletRecoveryMaterial).not.toHaveBeenCalled();

    const missing = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {}),
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: {
        code: 'passphrase_required',
        message: 'A passphrase is required',
        retryable: false,
      },
    });

    const invalid = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {
        passphrase: wrongPassphrase,
      }),
    );
    expect(invalid.status).toBe(401);
    expect(await invalid.json()).toEqual({
      error: {
        code: 'wallet_unlock_failed',
        message: 'Wallet unlock failed',
        retryable: false,
      },
    });

    const success = await recoveryRoute(
      authorizedJsonRequest('/v1/admin/wallet/recovery-material', credential.plaintext, {
        passphrase: correctPassphrase,
      }),
    );
    expect(await success.json()).toEqual({ mnemonic });

    const logs = JSON.stringify([
      debug.mock.calls,
      info.mock.calls,
      warn.mock.calls,
      error.mock.calls,
    ]);
    expect(logs).not.toContain(correctPassphrase);
    expect(logs).not.toContain(wrongPassphrase);
    expect(logs).not.toContain(mnemonic);
    expect(logs).not.toContain(credential.plaintext);
  });

  test('returns asynchronous Session transition status without awaiting completion', async () => {
    const credential = await createCredential();
    let status = configuredStatus('stopped');
    const startRequested = deferred<void>();
    const startAccepted = deferred<void>();
    const startCompletion = deferred<void>();
    const stopCompletion = deferred<void>();
    const runtime = lifecycleRuntime(() => status, {
      startSession: () => {
        startRequested.resolve();
        if (status.cocoSession.state === 'stopped') {
          status = { ...status, cocoSession: { ...status.cocoSession, state: 'starting' } };
        }
        return {
          accepted: startAccepted.promise,
          completion: startCompletion.promise.then(() => {
            status = {
              ...status,
              cocoSession: {
                state: 'running',
                startedAt: '2026-08-16T00:00:01.000Z',
                lastFailure: null,
              },
            };
          }),
        };
      },
      stopSession: () => {
        if (status.cocoSession.state === 'running') {
          status = { ...status, cocoSession: { ...status.cocoSession, state: 'stopping' } };
          return stopCompletion.promise.then(() => {
            status = configuredStatus('stopped');
          });
        }
        return Promise.resolve();
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const controller = new AbortController();
    const startingResponse = routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}, controller.signal),
    );
    await startRequested.promise;
    controller.abort();
    startAccepted.resolve();
    const starting = await startingResponse;
    expect(starting.status).toBe(202);
    expect(((await starting.json()) as LifecycleStatusDocument).cocoSession.state).toBe('starting');

    startCompletion.resolve();
    await startCompletion.promise;
    await Promise.resolve();
    expect(status.cocoSession.state).toBe('running');

    const alreadyRunning = await routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}),
    );
    expect(alreadyRunning.status).toBe(200);

    const stopping = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );
    expect(stopping.status).toBe(202);
    expect(((await stopping.json()) as LifecycleStatusDocument).cocoSession.state).toBe('stopping');

    stopCompletion.resolve();
    await stopCompletion.promise;
    await Promise.resolve();
    const alreadyStopped = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );
    expect(alreadyStopped.status).toBe(200);
  });

  test('returns accepted when stop cancels encrypted startup before Seed Access is acquired', async () => {
    const credential = await createCredential();
    let status: CocodStatus = {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    };
    const stopCompletion = deferred<void>();
    const runtime = lifecycleRuntime(() => status, {
      stopSession: () => {
        status = { ...status, cocoSession: { ...status.cocoSession, state: 'stopping' } };
        return stopCompletion.promise;
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
      credential.credentials,
    );

    const response = await routes['/v1/admin/session/stop']!.POST!(
      authorizedJsonRequest('/v1/admin/session/stop', credential.plaintext, {}),
    );

    expect(response.status).toBe(202);
    expect(((await response.json()) as LifecycleStatusDocument).cocoSession.state).toBe('stopping');
    stopCompletion.resolve();
  });

  test('logs detached transition failures without raw diagnostics', async () => {
    const credential = await createCredential();
    const completion = deferred<void>();
    const failureLogged = deferred<void>();
    const error = mock((event: string, _fields?: unknown) => {
      if (event === 'lifecycle.transition_failed') {
        failureLogged.resolve();
      }
    });
    const logger = createTestLogger({ error });
    let status = configuredStatus('stopped');
    const runtime = lifecycleRuntime(() => status, {
      startSession: () => {
        status = { ...status, cocoSession: { ...status.cocoSession, state: 'starting' } };
        return { accepted: Promise.resolve(), completion: completion.promise };
      },
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(runtime, '0.0.17', logger),
      credential.credentials,
      logger,
    );

    const response = await routes['/v1/admin/session/start']!.POST!(
      authorizedJsonRequest('/v1/admin/session/start', credential.plaintext, {}),
    );
    expect(response.status).toBe(202);
    completion.reject(new Error('postgres://owner:password@wallet-db'));
    await failureLogged.promise;

    expect(JSON.stringify(error.mock.calls)).not.toContain('postgres://owner:password@wallet-db');
    expect(error).toHaveBeenCalledWith('lifecycle.transition_failed', {
      transition: 'session_start',
      error: { name: 'Error' },
    });
  });

  test('maps every synchronous runtime lifecycle failure to stable v1 errors', async () => {
    const credential = await createCredential();
    const cases = [
      {
        path: '/v1/admin/wallet/initialize',
        code: 'wallet_already_configured',
        expectedStatus: 409,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'wallet_not_configured',
        expectedStatus: 409,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'passphrase_required',
        expectedStatus: 400,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'wallet_unlock_failed',
        expectedStatus: 401,
        retryable: false,
      },
      {
        path: '/v1/admin/session/start',
        code: 'session_transition_in_progress',
        expectedStatus: 409,
        retryable: true,
      },
      {
        path: '/v1/admin/session/start',
        code: 'session_restart_required',
        expectedStatus: 503,
        retryable: false,
      },
      {
        path: '/v1/admin/session/stop',
        code: 'session_restart_required',
        expectedStatus: 503,
        retryable: false,
      },
    ] as const;

    for (const testCase of cases) {
      const failure = new CocodRuntimeError(testCase.code, 'unsafe internal diagnostic');
      const runtime = lifecycleRuntime(() => configuredStatus('stopped'), {
        initializeWallet: async () => {
          throw failure;
        },
        startSession: () => {
          if (testCase.code === 'wallet_unlock_failed') {
            const rejected = Promise.reject(failure);
            return { accepted: rejected, completion: rejected };
          }
          throw failure;
        },
        stopSession: () => {
          throw failure;
        },
      });
      const routes = buildV1Routes(
        createLifecycleTestRouteDefinitions(runtime, '0.0.17'),
        credential.credentials,
      );
      const response = await routes[testCase.path]!.POST!(
        authorizedJsonRequest(testCase.path, credential.plaintext, {}),
      );
      const document = (await response.json()) as {
        error: { code: string; message: string; retryable: boolean };
      };

      expect(response.status).toBe(testCase.expectedStatus);
      expect(document.error.code).toBe(testCase.code);
      expect(document.error.retryable).toBe(testCase.retryable);
      expect(document.error.message).not.toContain('unsafe internal diagnostic');
    }
  });

  test('replays lifecycle mutations by key and rejects conflicting request content', async () => {
    const credential = await createCredential();
    const initialized = deferred<void>();
    let status = unconfiguredStatus();
    const initializeWallet = mock(async (input: { passphrase?: string }) => {
      await initialized.promise;
      const requiresPassphrase = Boolean(input.passphrase);
      status = {
        wallet: {
          configuredAt: '2026-08-16T00:00:00.000Z',
          mintUrl: 'https://mint.example.com',
        },
        seedAccess: {
          state: requiresPassphrase ? 'locked' : 'available',
          requiresPassphrase,
        },
        cocoSession: {
          state: requiresPassphrase ? 'stopped' : 'starting',
          startedAt: null,
          lastFailure: null,
        },
      };
      return {
        mnemonic:
          'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        requiresPassphrase,
      };
    });
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(
        lifecycleRuntime(() => status, { initializeWallet }),
        '0.0.17',
      ),
      credential.credentials,
    );
    const request = () =>
      authorizedJsonRequest(
        '/v1/admin/wallet/initialize',
        credential.plaintext,
        { passphrase: 'correct horse' },
        undefined,
        { 'Idempotency-Key': 'initialize-wallet-1' },
      );

    const firstResponse = routes['/v1/admin/wallet/initialize']!.POST!(request());
    const concurrentReplay = routes['/v1/admin/wallet/initialize']!.POST!(request());
    await Promise.resolve();
    initialized.resolve();
    const [first, concurrent] = await Promise.all([firstResponse, concurrentReplay]);
    const firstBody = await first.json();
    const concurrentBody = await concurrent.json();

    expect(initializeWallet).toHaveBeenCalledTimes(1);
    expect(concurrent.status).toBe(201);
    expect(concurrentBody).toEqual(firstBody);

    const completedReplay = await routes['/v1/admin/wallet/initialize']!.POST!(request());
    expect(completedReplay.status).toBe(201);
    expect(await completedReplay.json()).toEqual(firstBody);
    expect(initializeWallet).toHaveBeenCalledTimes(1);

    const conflict = await routes['/v1/admin/wallet/initialize']!.POST!(
      authorizedJsonRequest('/v1/admin/wallet/initialize', credential.plaintext, {}, undefined, {
        'Idempotency-Key': 'initialize-wallet-1',
      }),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: 'idempotency_key_conflict', retryable: false },
    });
    expect(initializeWallet).toHaveBeenCalledTimes(1);
  });

  test('returns stable authentication and capability errors without legacy envelopes', async () => {
    const credential = await createCredential();
    const routes = buildV1Routes(
      createLifecycleTestRouteDefinitions(statusRuntime(unconfiguredStatus()), '0.0.17'),
      credential.credentials,
    );

    const unauthenticated = await routes['/v1/status']!.GET!(
      new Request('http://localhost/v1/status'),
    );
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get('www-authenticate')).toBe('Bearer');
    expect(await unauthenticated.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: 'A valid Client Credential is required',
        retryable: false,
      },
    });

    const invalidCredential = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', 'x'.repeat(43)),
    );
    expect(invalidCredential.status).toBe(401);
    expect(await invalidCredential.json()).toMatchObject({
      error: { code: 'unauthenticated', retryable: false },
    });

    await setCapabilities(credential.verifierFile, ['wallet:admin']);
    const forbidden = await routes['/v1/status']!.GET!(
      authorizedRequest('/v1/status', credential.plaintext),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'The Client Credential lacks the required capability',
        retryable: false,
      },
    });
  });

  test('rejects a route declaration that leaves a /v1 resource unauthenticated', async () => {
    const credential = await createCredential();
    const route = defineV1Route({
      method: 'GET',
      path: '/v1/public-by-mistake',
      capability: null,
      requestSchema: {
        name: 'NoBody',
        jsonSchema: { type: 'null' },
        parse: () => null,
      },
      responseSchema: {
        name: 'Ok',
        jsonSchema: { type: 'object' },
        parse: () => ({ ok: true }),
      },
      handler: async () => ({ ok: true }),
    });

    expect(() => buildV1Routes([route], credential.credentials)).toThrow(
      'V1 route GET /v1/public-by-mistake must require a capability',
    );
  });

  test('validates input and output and maps failures to stable errors', async () => {
    const credential = await createCredential();
    const requestSchema: RuntimeSchema<{ label: string }> = {
      name: 'TestRequest',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: { label: { type: 'string' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.label !== 'string') {
          throw new Error('label must be a string');
        }
        return { label: value.label };
      },
    };
    const responseSchema: RuntimeSchema<{ accepted: boolean }> = {
      name: 'TestResponse',
      jsonSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['accepted'],
        properties: { accepted: { type: 'boolean' } },
      },
      parse(value) {
        if (!isRecord(value) || typeof value.accepted !== 'boolean') {
          throw new Error('accepted must be a boolean');
        }
        return { accepted: value.accepted };
      },
    };
    const route = defineV1Route<{ label: string }, { accepted: boolean }>({
      method: 'POST',
      path: '/v1/test',
      capability: 'wallet:admin',
      requestSchema,
      responseSchema,
      handler: async () => ({ accepted: true }),
    });
    const routes = buildV1Routes([route], credential.credentials);

    const malformed = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.plaintext}` },
        body: '{not-json',
      }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request body is not valid JSON',
        retryable: false,
      },
    });

    const invalid = await routes['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 21 }),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_request', retryable: false },
    });

    const invalidOutput = buildV1Routes(
      [{ ...route, handler: async () => ({ accepted: 'yes' }) }],
      credential.credentials,
    );
    const failed = await invalidOutput['/v1/test']!.POST!(
      new Request('http://localhost/v1/test', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ label: 'safe' }),
      }),
    );
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed',
        retryable: false,
      },
    });
  });

  test('redacts sensitive input fields in centralized request logs', async () => {
    const credential = await createCredential();
    const debug = mock((_event: string, _fields?: unknown) => {});
    const logger = createTestLogger({ debug });
    const requestSchema: RuntimeSchema<{ passphrase: string; label: string }> = {
      name: 'SensitiveRequest',
      jsonSchema: { type: 'object' },
      parse(value) {
        if (!isRecord(value) || typeof value.passphrase !== 'string') {
          throw new Error('invalid');
        }
        return { passphrase: value.passphrase, label: String(value.label) };
      },
    };
    const responseSchema: RuntimeSchema<{ ok: true }> = {
      name: 'Ok',
      jsonSchema: { type: 'object' },
      parse: () => ({ ok: true }),
    };
    const routes = buildV1Routes(
      [
        defineV1Route({
          method: 'POST',
          path: '/v1/sensitive',
          capability: 'wallet:admin',
          requestSchema,
          responseSchema,
          handler: async () => ({ ok: true }),
        }),
      ],
      credential.credentials,
      logger,
    );

    await routes['/v1/sensitive']!.POST!(
      new Request('http://localhost/v1/sensitive', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential.plaintext}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ passphrase: 'open sesame', label: 'visible' }),
      }),
    );

    expect(JSON.stringify(debug.mock.calls)).not.toContain('open sesame');
    expect(debug).toHaveBeenCalledWith('request.received', {
      input: { passphrase: '[REDACTED]', label: 'visible' },
    });
  });
});

function statusRuntime(status: CocodStatus): V1Runtime {
  return lifecycleRuntime(() => status);
}

function mintQuoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    mintUrl: 'https://mint.example.com',
    method: 'bolt11' as const,
    quoteId: 'mint-quote-1',
    quote: 'mint-quote-1',
    request: 'lnbc250n1quote',
    amount: toAmount(25),
    unit: 'sat',
    expiry: 1_786_838_700,
    reusable: false as const,
    state: 'UNPAID' as const,
    amountPaid: toAmount(0),
    amountIssued: toAmount(0),
    remoteUpdatedAt: null,
    quoteData: { amount: toAmount(25) },
    createdAt: 1_786_838_400_000,
    updatedAt: 1_786_838_460_000,
    ...overrides,
  };
}

function meltQuoteFixture(overrides: Record<string, unknown> = {}) {
  return {
    mintUrl: 'https://mint.example.com',
    method: 'bolt11' as const,
    quoteId: 'melt-quote-1',
    quote: 'melt-quote-1',
    request: 'lnbc250n1pay',
    amount: toAmount(25),
    unit: 'sat',
    fee_reserve: toAmount(2),
    expiry: 1_786_838_700,
    state: 'UNPAID' as const,
    createdAt: 1_786_838_400_000,
    updatedAt: 1_786_838_460_000,
    ...overrides,
  };
}

function sendOperationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'send-operation-1',
    state: 'prepared' as const,
    mintUrl: 'https://mint.example.com',
    amount: toAmount(25),
    unit: 'sat',
    method: 'default' as const,
    methodData: { mustNotLeak: 'method-data' },
    createdAt: 1_786_838_400_000,
    updatedAt: 1_786_838_460_000,
    needsSwap: true,
    fee: toAmount(2),
    inputAmount: toAmount(27),
    inputProofSecrets: ['must-not-leak'],
    outputData: { mustNotLeak: 'output-data' },
    ...overrides,
  };
}

function createQuoteTestRoutes(manager: unknown, credential: AdministrativeCredential) {
  const runtime = {
    ...lifecycleRuntime(() => configuredStatus('running')),
    getRunningSession: () => ({ manager }),
  } as unknown as V1Runtime;
  return buildV1Routes(createLifecycleTestRouteDefinitions(runtime, '0.0.17'), credential);
}

const createSendTestRoutes = createQuoteTestRoutes;

function lifecycleRuntime(
  getStatus: () => CocodStatus,
  overrides: Partial<V1Runtime> = {},
): V1Runtime {
  return {
    getStatus,
    getRunningSession: () => null,
    initializeWallet: async () => {
      throw new Error('initializeWallet was not expected');
    },
    getWalletRecoveryMaterial: async () => {
      throw new Error('getWalletRecoveryMaterial was not expected');
    },
    startSession: () => {
      throw new Error('startSession was not expected');
    },
    stopSession: async () => {
      throw new Error('stopSession was not expected');
    },
    ...overrides,
  };
}

function unconfiguredStatus(): CocodStatus {
  return {
    wallet: null,
    seedAccess: null,
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  };
}

function configuredStatus(state: CocodStatus['cocoSession']['state']): CocodStatus {
  return {
    wallet: {
      configuredAt: '2026-08-16T00:00:00.000Z',
      mintUrl: 'https://mint.example.com',
    },
    seedAccess: { state: 'available', requiresPassphrase: false },
    cocoSession: {
      state,
      startedAt: state === 'running' ? '2026-08-16T00:00:01.000Z' : null,
      lastFailure:
        state === 'failed'
          ? {
              code: 'session_start_failed',
              message: 'Coco Session failed to start',
              occurredAt: '2026-08-16T00:00:02.000Z',
            }
          : null,
    },
  };
}

async function createCredential(): Promise<{
  credentials: AdministrativeCredential;
  plaintext: string;
  verifierFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'cocod-v1-http-'));
  directories.push(directory);
  const credentialDirectory = join(directory, 'credentials');
  const currentDirectory = join(credentialDirectory, 'current');
  const credentials = await AdministrativeCredential.loadOrBootstrap({ credentialDirectory });
  return {
    credentials,
    plaintext: await loadClientCredential(join(currentDirectory, 'client')),
    verifierFile: join(currentDirectory, 'verifier.json'),
  };
}

async function setCapabilities(path: string, capabilities: ClientCapability[]): Promise<void> {
  const state = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  state.capabilities = capabilities;
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}

function authorizedRequest(path: string, credential: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
}

function authorizedPostRequest(
  path: string,
  credential: string,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential}`, ...headers },
  });
}

function authorizedJsonRequest(
  path: string,
  credential: string,
  body: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
