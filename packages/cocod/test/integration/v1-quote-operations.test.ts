import { afterEach, describe, expect, test } from 'bun:test';
import { Amount } from '@cashu/coco-core';

import type { CocodStatus } from '../../src/runtime.js';
import {
  cleanupQuoteHarnesses,
  errorOf,
  runningStatus,
  startQuoteHarness,
} from '../helpers/quote-operations.js';

afterEach(cleanupQuoteHarnesses);

describe('v1 Quote-backed Operations over a real Coco Session', () => {
  test('create a Mint Quote and prepare its Mint Operation without executing it', async () => {
    const harness = await startQuoteHarness();
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });

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
    const harness = await startQuoteHarness();
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
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

  test('refuse an idempotent replay while the Wallet is unavailable', async () => {
    const harness = await startQuoteHarness();
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
    const create = () =>
      harness.call('POST', '/v1/quotes/mint', {
        body: { method: 'bolt11', amount: '5' },
        headers: { 'Idempotency-Key': 'quote-1' },
      });
    const first = (await (await create()).json()) as { quoteId: string };

    harness.setStatus({
      ...runningStatus(),
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    } as CocodStatus);
    const locked = await create();
    expect([locked.status, (await errorOf(locked)).code]).toEqual([423, 'wallet_locked']);

    harness.setStatus(runningStatus());
    const replay = (await (await create()).json()) as { quoteId: string };
    expect(replay.quoteId).toBe(first.quoteId);
  });
});

test('quote identities are Mint-scoped, normalized, and isolated between namespaces', async () => {
  const h = await startQuoteHarness();
  await h.manager.mint.addMint(h.mint.url, { trusted: true });
  const created = await h.call('POST', '/v1/quotes/mint', {
    body: { method: 'bolt11', amount: '5', mintUrl: `${h.mint.url}/` },
  });
  const quote = (await created.json()) as { quoteId: string };
  const query = `mintUrl=${encodeURIComponent(`${h.mint.url}/`)}`;
  const refreshed = await h.call('POST', `/v1/quotes/mint/${quote.quoteId}/refresh?${query}`, {
    body: {},
  });
  expect(refreshed.status).toBe(200);
  expect(await refreshed.json()).toMatchObject({ quoteId: quote.quoteId, state: 'UNPAID' });
  for (const path of [
    `/v1/quotes/melt/${quote.quoteId}?${query}`,
    `/v1/quotes/mint/${quote.quoteId}?mintUrl=https://unknown.example`,
  ]) {
    const missing = await h.call('GET', path);
    expect([missing.status, (await errorOf(missing)).code]).toEqual([404, 'not_found']);
  }
  const wrongNamespace = await h.call('POST', '/v1/operations/melt', {
    body: { mintUrl: h.mint.url, quoteId: quote.quoteId },
  });
  expect([wrongNamespace.status, (await errorOf(wrongNamespace)).code]).toEqual([404, 'not_found']);
  expect(
    await (await h.call('GET', '/v1/quotes/mint/pending?offset=1&limit=1&method=bolt11')).json(),
  ).toEqual({ items: [], offset: 1, limit: 1 });
});

test('operation commands preserve typed missing-identity errors and result cache policy', async () => {
  const h = await startQuoteHarness();
  for (const [family, commands] of [
    ['mint', ['execute', 'refresh']],
    ['melt', ['execute', 'refresh', 'cancel', 'reclaim']],
  ] as const) {
    for (const command of commands) {
      const response = await h.call('POST', `/v1/operations/${family}/missing/${command}`);
      expect(response.status).toBe(404);
      expect(await errorOf(response)).toMatchObject({
        code: 'not_found',
        details: {
          operationType: family,
          operationId: 'missing',
        },
      });
      if (family === 'melt' && command === 'execute')
        expect(response.headers.get('cache-control')).toBe('no-store');
    }
  }
  const response = await h.call('GET', '/v1/operations/melt/missing/result');
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('read-only credentials can inspect quotes but cannot replay commands or read Melt results', async () => {
  const h = await startQuoteHarness();
  await h.manager.mint.addMint(h.mint.url, { trusted: true });
  const body = { method: 'bolt11', amount: '5' };
  const headers = { 'Idempotency-Key': 'admin-quote' };
  expect((await h.call('POST', '/v1/quotes/mint', { body, headers })).status).toBe(201);
  await h.readOnlyCredential();
  expect((await h.call('GET', '/v1/quotes/mint/pending')).status).toBe(200);
  expect((await h.call('POST', '/v1/quotes/mint', { body, headers })).status).toBe(403);
  for (const [method, path] of [
    ['POST', '/v1/operations/melt/missing/execute'],
    ['GET', '/v1/operations/melt/missing/result'],
  ] as const) {
    const response = await h.call(method, path);
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(h.mint.requests.filter((r) => r === 'POST /v1/mint/quote/bolt11')).toHaveLength(1);
});

test('reject invalid quote and operation inputs before contacting a Mint', async () => {
  const h = await startQuoteHarness();
  const cases: Array<['GET' | 'POST', string, unknown, string?]> = [
    ['GET', '/v1/quotes/mint/pending?limit=0', undefined, 'limit'],
    ['GET', '/v1/quotes/melt/pending?limit=1&limit=2', undefined, 'limit'],
    ['GET', '/v1/operations/mint/pending?unexpected=1', undefined, 'unexpected'],
    ['GET', '/v1/quotes/mint/pending?method=unknown', undefined, 'method'],
    ['GET', '/v1/quotes/mint/quote-1', undefined, 'mintUrl'],
    ['POST', '/v1/quotes/mint', { method: 'bolt11', amount: '-1' }],
    ['POST', '/v1/quotes/mint', { method: 'bolt11', amount: '18446744073709551616' }],
    ['POST', '/v1/quotes/mint', { method: 'bolt12', amount: '0' }],
    ['POST', '/v1/quotes/mint', { method: 'onchain', amount: '1' }],
    ['POST', '/v1/quotes/melt', { method: 'bolt12', invoice: 'wrong field' }],
    ['POST', '/v1/quotes/melt', { method: 'onchain', address: 'address' }],
    ['POST', '/v1/quotes/melt', { method: 'bolt11', invoice: 'invoice', amountSats: 1 }],
    ['POST', '/v1/quotes/mint', { method: 'bolt11', amount: '1', mintUrl: 'ftp://mint.example' }],
    [
      'POST',
      '/v1/quotes/mint',
      { method: 'bolt11', amount: '1', mintUrl: 'https://user:pass@mint.example' },
    ],
    ['POST', '/v1/operations/mint', { mintUrl: h.mint.url, quoteId: 'q', amount: '0' }],
    ['POST', '/v1/operations/melt', { mintUrl: h.mint.url, quoteId: 'q', feeIndex: -1 }],
    ['POST', '/v1/operations/melt/missing/execute', { unexpected: true }],
  ];
  for (const [method, path, body, parameter] of cases) {
    const response = await h.call(method, path, { body });
    const error = await errorOf(response);
    expect([path, response.status, error.code]).toEqual([path, 400, 'invalid_request']);
    if (parameter) expect(error.details).toEqual({ parameter });
    if (path.endsWith('/execute')) expect(response.headers.get('cache-control')).toBe('no-store');
  }
  expect(h.mint.requests).toEqual([]);
});

test('persisted terminal Mint failures expose structured fields without Mint text or output material', async () => {
  const h = await startQuoteHarness();
  await h.manager.mint.addMint(h.mint.url, { trusted: true });
  const quote = await h.manager.quotes.mint.create({
    mintUrl: h.mint.url,
    method: 'bolt11',
    amount: '5',
  });
  const prepared = await h.manager.ops.mint.prepare({ quote, amount: '5' });
  // A historical terminal record exercises the real repository -> API -> HTTP projection.
  await h.repositories.mintOperationRepository.update({
    ...prepared,
    state: 'failed',
    error: 'private Mint diagnostic',
    terminalFailure: {
      reason: 'private Mint diagnostic',
      code: 'quote-rejected',
      retryable: false,
      observedAt: 1000,
    },
  });
  const read = await h.call('GET', `/v1/operations/mint/${prepared.id}`);
  expect(read.status).toBe(200);
  const value = (await read.json()) as Record<string, unknown>;
  expect(value).toMatchObject({
    state: 'failed',
    failure: {
      code: 'quote-rejected',
      retryable: false,
      observedAt: '1970-01-01T00:00:01.000Z',
    },
  });
  expect(Object.keys(value).toSorted()).toEqual([
    'amount',
    'createdAt',
    'expiry',
    'failure',
    'id',
    'method',
    'mintUrl',
    'quote',
    'state',
    'type',
    'unit',
    'updatedAt',
  ]);
  expect(JSON.stringify(value)).not.toContain('private Mint diagnostic');
  const execute = await h.call('POST', `/v1/operations/mint/${prepared.id}/execute`);
  // Mint execution is terminal-idempotent: an already failed operation is read back unchanged.
  expect(execute.status).toBe(200);
  expect(await execute.json()).toEqual(value);
  expect(h.mint.requests.filter((request) => request === 'POST /v1/mint/bolt11')).toEqual([]);
});

test('stored BOLT11 preimages are available only through the administrative result projection', async () => {
  const h = await startQuoteHarness();
  // CDK fakewallet intentionally supplies an empty preimage. Seed a terminal historical row to
  // cover a nonempty BOLT11 result at the real SQLite/Manager/HTTP boundary as well.
  await h.repositories.meltOperationRepository.create({
    id: 'settled-bolt11',
    state: 'finalized',
    mintUrl: h.mint.url,
    method: 'bolt11',
    methodData: { invoice: 'private-invoice' },
    unit: 'sat',
    quoteId: 'settled-quote',
    amount: Amount.from(20),
    fee_reserve: Amount.from(2),
    swap_fee: Amount.zero(),
    inputAmount: Amount.from(22),
    needsSwap: false,
    inputProofSecrets: ['private-proof-secret'],
    changeOutputData: { keep: [], send: [] },
    changeAmount: Amount.zero(),
    effectiveFee: Amount.from(2),
    finalizedData: { preimage: 'private-payment-preimage' },
    createdAt: 1000,
    updatedAt: 2000,
  });
  const read = await h.call('GET', '/v1/operations/melt/settled-bolt11');
  expect(read.status).toBe(200);
  const operation = await read.json();
  expect(JSON.stringify(operation)).not.toContain('private-');
  expect(operation).toMatchObject({ id: 'settled-bolt11', state: 'finalized', amount: '20' });
  const result = await h.call('GET', '/v1/operations/melt/settled-bolt11/result');
  expect(result.status).toBe(200);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await result.json()).toEqual({ preimage: 'private-payment-preimage' });
  await h.readOnlyCredential();
  expect(await (await h.call('GET', '/v1/operations/melt/settled-bolt11')).json()).toEqual(
    operation,
  );
  const denied = await h.call('GET', '/v1/operations/melt/settled-bolt11/result');
  expect(denied.status).toBe(403);
  expect(denied.headers.get('cache-control')).toBe('no-store');
});
