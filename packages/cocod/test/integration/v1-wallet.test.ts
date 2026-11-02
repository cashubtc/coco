import { describe, expect, test } from 'bun:test';
import { Amount, type CoreProof, type SendOperation } from '@cashu/coco-core';

import type { CocodStatus } from '../../src/runtime.js';
import type { BalancesDocument, HistoryDocument, PageDocument } from '../../src/v1/http.js';
import { runningStatus, startWalletHarness, UNREACHABLE_MINT } from '../helpers/v1-wallet.js';

async function errorOf(response: Response) {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

describe('v1 balances, Known Mints, and history over a real Coco Session', () => {
  test('report the lifecycle state that prevents Wallet-dependent work', async () => {
    const harness = await startWalletHarness();
    const cases: Array<
      [CocodStatus['cocoSession']['state'], 'available' | 'locked', number, string]
    > = [
      ['stopping', 'available', 503, 'session_transition_in_progress'],
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
      for (const [method, path, body] of walletRequests(harness.mint.url)) {
        const response = await harness.call(method, path, { body });
        expect([path, response.status, (await errorOf(response)).code]).toEqual([
          path,
          status,
          code,
        ]);
      }
    }
    harness.setStatus({
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    });
    for (const [method, path, body] of walletRequests(harness.mint.url)) {
      const response = await harness.call(method, path, { body });
      expect([response.status, (await errorOf(response)).code]).toEqual([
        409,
        'wallet_not_configured',
      ]);
    }
    expect(harness.mint.requests).toEqual([]);
    expect(await harness.manager.mint.getAllMints()).toEqual([]);
  });

  test('register, trust, and describe a Known Mint served by a Mint', async () => {
    const harness = await startWalletHarness();

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
    const harness = await startWalletHarness();

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
  });

  test('reject invalid parameters and request bodies before calling Coco', async () => {
    const harness = await startWalletHarness();

    const cases: Array<[string, string, unknown, string | undefined]> = [
      ['GET', '/v1/history?limit=0', undefined, 'limit'],
      ['GET', '/v1/history?limit=1&limit=2', undefined, 'limit'],
      ['GET', '/v1/balances?unexpected=1', undefined, 'unexpected'],
      ['GET', '/v1/history/not-an-entry-id', undefined, 'historyEntryId'],
      ['GET', '/v1/mints/info', undefined, 'mintUrl'],
      ['GET', '/v1/history?limit=101', undefined, 'limit'],
      ['GET', '/v1/history?offset=-1', undefined, 'offset'],
      ['GET', '/v1/history?offset=9007199254740992', undefined, 'offset'],
      ['GET', '/v1/balances?unit=', undefined, 'unit'],
      ['GET', '/v1/balances?trustedOnly=yes', undefined, 'trustedOnly'],
      ['GET', '/v1/balances?mintUrl=ftp://mint.example.com', undefined, 'mintUrl'],
      ['GET', '/v1/mints?trustedOnly=true&trustedOnly=false', undefined, 'trustedOnly'],
      ['GET', '/v1/mints/info?mintUrl=http://user:secret@mint.example.com', undefined, 'mintUrl'],
      ['GET', '/v1/mints/payment-method-capabilities', undefined, 'mintUrl'],
      ['POST', '/v1/mints', { mintUrl: 'ftp://mint.example.com' }, undefined],
      ['POST', '/v1/mints', { mintUrl: 'http://user:secret@mint.example.com' }, undefined],
      ['POST', '/v1/mints', { mintUrl: harness.mint.url, trusted: 'true' }, undefined],
      ['POST', '/v1/mints', { mintUrl: harness.mint.url, extra: true }, undefined],
      ['POST', '/v1/mints/trust', {}, undefined],
      ['POST', '/v1/mints/untrust', { mintUrl: 'relative' }, undefined],
    ];
    for (const [method, path, body, parameter] of cases) {
      const response = await harness.call(method as 'GET' | 'POST', path, { body });
      const error = await errorOf(response);
      expect([path, response.status, error.code]).toEqual([path, 400, 'invalid_request']);
      if (parameter) expect(error.details).toEqual({ parameter });
    }
    expect(harness.mint.requests).toEqual([]);
    expect(await harness.manager.mint.getAllMints()).toEqual([]);
  });
});

function walletRequests(mintUrl: string): Array<['GET' | 'POST', string, unknown?]> {
  const query = `mintUrl=${encodeURIComponent(mintUrl)}`;
  return [
    ['GET', '/v1/balances'],
    ['GET', '/v1/mints'],
    ['POST', '/v1/mints', { mintUrl }],
    ['POST', '/v1/mints/trust', { mintUrl }],
    ['POST', '/v1/mints/untrust', { mintUrl }],
    ['GET', `/v1/mints/info?${query}`],
    ['GET', `/v1/mints/payment-method-capabilities?${query}`],
    ['GET', '/v1/history'],
    ['GET', '/v1/history/send:missing'],
  ];
}

test('all Wallet routes authenticate, and read credentials cannot change Known Mints', async () => {
  const harness = await startWalletHarness();
  for (const [method, path, body] of walletRequests(harness.mint.url)) {
    const response = await harness.call(method, path, { body, credential: 'invalid' });
    expect([path, response.status]).toEqual([path, 401]);
  }
  expect(harness.mint.requests).toEqual([]);
  await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url } });
  const requests = [...harness.mint.requests];
  await harness.readOnlyCredential();
  for (const [method, path, body] of walletRequests(harness.mint.url)) {
    const response = await harness.call(method, path, { body });
    expect([path, response.status]).toEqual([
      path,
      method === 'POST' ? 403 : path.endsWith('send:missing') ? 404 : 200,
    ]);
  }
  expect(await harness.manager.mint.isTrustedMint(harness.mint.url)).toBe(false);
  expect(harness.mint.requests).toEqual(requests);
});

test('registration defaults to untrusted, preserves trust, and keyed replay requires an available Session', async () => {
  const harness = await startWalletHarness();
  const body = { mintUrl: harness.mint.url };
  const options = { body, headers: { 'Idempotency-Key': 'register-known-mint' } };
  const registered = await harness.call('POST', '/v1/mints', options);
  const document = await registered.json();
  expect(document).toMatchObject({
    mintUrl: harness.mint.url,
    trusted: false,
    name: harness.mint.url,
  });
  expect(harness.mint.requests).toEqual(
    expect.arrayContaining(['GET /v1/info', 'GET /v1/keysets']),
  );
  const requests = [...harness.mint.requests];
  const replay = await harness.call('POST', '/v1/mints', options);
  expect(await replay.json()).toEqual(document);
  expect(harness.mint.requests).toEqual(requests);
  const trust = await harness.call('POST', '/v1/mints/trust', { body });
  expect(trust.status).toBe(200);
  expect(await trust.json()).toMatchObject({ trusted: true });
  expect(await (await harness.call('POST', '/v1/mints', { body })).json()).toMatchObject({
    trusted: true,
  });
  harness.setStatus({
    ...runningStatus(),
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  });
  const stopped = await harness.call('POST', '/v1/mints', options);
  expect([stopped.status, (await errorOf(stopped)).code]).toEqual([503, 'session_stopped']);
});

test('trust changes remain committed when the Mint is offline, and unknown Mint reads do not register it', async () => {
  const harness = await startWalletHarness();
  for (const [method, path, body] of walletRequests(harness.mint.url).filter(([, path]) =>
    [
      '/v1/mints/trust',
      '/v1/mints/untrust',
      '/v1/mints/info?',
      '/v1/mints/payment-method-capabilities?',
    ].some((prefix) => path.startsWith(prefix)),
  )) {
    const response = await harness.call(method, path, { body });
    expect([response.status, (await errorOf(response)).code]).toEqual([404, 'not_found']);
  }
  expect(harness.mint.requests).toEqual([]);
  await harness.call('POST', '/v1/mints', { body: { mintUrl: harness.mint.url } });
  await harness.mint.stop();
  for (const [path, trusted] of [
    ['trust', true],
    ['untrust', false],
  ] as const) {
    const response = await harness.call('POST', `/v1/mints/${path}`, {
      body: { mintUrl: harness.mint.url },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ trusted });
    expect(await harness.manager.mint.isTrustedMint(harness.mint.url)).toBe(trusted);
  }
});

/** Stored proof fixtures exercise accounting only; no fixture is submitted to a Mint. */
function storedProof(
  mintUrl: string,
  secret: string,
  amount: string,
  overrides: Partial<CoreProof> = {},
): CoreProof {
  return {
    mintUrl,
    unit: 'sat',
    id: '009a1f293253e41e',
    C: '02'.padEnd(66, '1'),
    secret,
    amount: Amount.from(amount),
    state: 'ready',
    ...overrides,
  };
}

test('balances preserve precision, reservations, units, trust filters, and legacy route removal', async () => {
  const harness = await startWalletHarness();
  expect(await (await harness.call('GET', '/v1/balances')).json()).toEqual({ items: [] });
  const mintUrl = harness.mint.url;
  const otherMint = 'https://stored.example.com';
  await harness.call('POST', '/v1/mints', { body: { mintUrl, trusted: true } });
  await harness.repositories.mintRepository.addNewMint({
    mintUrl: otherMint,
    name: 'Stored Mint',
    mintInfo: await harness.manager.mint.getMintInfo(mintUrl),
    trusted: false,
    createdAt: 1,
    updatedAt: 1,
  });
  await harness.repositories.proofRepository.saveProofs(mintUrl, [
    storedProof(mintUrl, 'spendable', '8'),
    storedProof(mintUrl, 'reserved', '4', { usedByOperationId: 'prepared-send' }),
    storedProof(mintUrl, 'large-usd', '9007199254740993', { unit: 'usd' }),
    ...(['pending', 'inflight', 'spent'] as const).map((state) =>
      storedProof(mintUrl, state, '32', { state }),
    ),
  ]);
  await harness.repositories.proofRepository.saveProofs(otherMint, [
    storedProof(otherMint, 'other', '2'),
  ]);
  const requests = [...harness.mint.requests];
  const response = await harness.call('GET', '/v1/balances');
  expect(response.status).toBe(200);
  const balances = (await response.json()) as BalancesDocument;
  expect(balances.items).toHaveLength(3);
  expect(balances.items).toEqual(
    expect.arrayContaining([
      { mintUrl, unit: 'sat', spendable: '8', reserved: '4', total: '12' },
      {
        mintUrl,
        unit: 'usd',
        spendable: '9007199254740993',
        reserved: '0',
        total: '9007199254740993',
      },
      { mintUrl: otherMint, unit: 'sat', spendable: '2', reserved: '0', total: '2' },
    ]),
  );
  const query = new URLSearchParams();
  query.append('mintUrl', `${mintUrl}/`);
  query.append('mintUrl', otherMint);
  query.append('unit', 'sat');
  query.append('unit', 'eur');
  query.set('trustedOnly', 'true');
  const filtered = await harness.call('GET', `/v1/balances?${query}`);
  expect(await filtered.json()).toEqual({
    items: [
      { mintUrl, unit: 'sat', spendable: '8', reserved: '4', total: '12' },
      { mintUrl, unit: 'eur', spendable: '0', reserved: '0', total: '0' },
    ],
  });
  const legacy = await harness.call('GET', '/balance');
  expect(legacy.status).toBe(404);
  expect(await legacy.json()).toEqual({ error: `Unknown endpoint: ${legacy.url}` });
  const legacyMints = await harness.call('GET', '/mints/list');
  expect(legacyMints.status).toBe(404);
  expect(await legacyMints.json()).toEqual({ error: `Unknown endpoint: ${legacyMints.url}` });
  expect(harness.mint.requests).toEqual(requests);
});

test('history paginates stored operation and legacy projections without exposing bearer value or diagnostics', async () => {
  const harness = await startWalletHarness();
  expect(await (await harness.call('GET', '/v1/history')).json()).toEqual({
    items: [],
    offset: 0,
    limit: 20,
  });
  const mintUrl = harness.mint.url;
  const operation: SendOperation = {
    id: 'stored/send',
    state: 'finalized',
    mintUrl,
    amount: Amount.from('9007199254740993'),
    unit: 'sat',
    method: 'default',
    methodData: {},
    createdAt: 3000,
    updatedAt: 4000,
    needsSwap: false,
    fee: Amount.from(0),
    inputAmount: Amount.from('9007199254740993'),
    inputProofSecrets: ['private-input'],
    error: 'private-error',
    token: { mint: mintUrl, proofs: [storedProof(mintUrl, 'private-token', '1')] },
  };
  await harness.repositories.sendOperationRepository.create(operation);
  // Historical rows have no write API; insert their persisted format to test the real SQL projection.
  const insert = harness.database.prepare(`INSERT INTO coco_cashu_history
    (id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, metadata, operationId)
    VALUES (?, ?, ?, 'sat', '7', ?, ?, 'finalized', 'private-payment-request', '{"memo":"private-metadata"}', ?)`);
  insert.run(1, mintUrl, 'mint', 2000, 'quote-legacy', null);
  insert.run(2, mintUrl, 'receive', 1000, null, null);
  insert.run(3, mintUrl, 'melt', 1000, '   ', null);
  // A migrated legacy row associated with a current operation must not duplicate its entry.
  insert.run(4, mintUrl, 'send', 3000, null, operation.id);

  const response = await harness.call('GET', '/v1/history');
  expect(response.status).toBe(200);
  const history = (await response.json()) as PageDocument<HistoryDocument>;
  expect(history.items.map((entry) => entry.id)).toEqual([
    'send:stored/send',
    'legacy:1',
    'legacy:3',
    'legacy:2',
  ]);
  expect(history.items[0]).toEqual({
    id: 'send:stored/send',
    type: 'send',
    source: 'operation',
    operationId: 'stored/send',
    state: 'finalized',
    mintUrl,
    unit: 'sat',
    amount: '9007199254740993',
    createdAt: '1970-01-01T00:00:03.000Z',
    updatedAt: '1970-01-01T00:00:04.000Z',
  });
  expect(history.items[1]).toEqual({
    id: 'legacy:1',
    type: 'mint',
    source: 'legacy',
    quoteId: 'quote-legacy',
    state: 'finalized',
    mintUrl,
    unit: 'sat',
    amount: '7',
    createdAt: '1970-01-01T00:00:02.000Z',
    updatedAt: '1970-01-01T00:00:02.000Z',
  });
  expect(history.items[2]).not.toHaveProperty('quoteId');
  expect(JSON.stringify(history)).not.toContain('private-');
  // Confirm the private fixture fields are present below HTTP, so omission is not vacuous.
  expect(await harness.manager.history.getHistoryEntryById('send:stored/send')).toMatchObject({
    token: expect.anything(),
    error: 'private-error',
  });
  expect(await harness.manager.history.getHistoryEntryById('legacy:1')).toMatchObject({
    paymentRequest: 'private-payment-request',
    metadata: { memo: 'private-metadata' },
  });
  for (const [offset, limit] of [
    [0, 2],
    [2, 2],
    [10, 100],
  ] as const) {
    expect(
      await (await harness.call('GET', `/v1/history?offset=${offset}&limit=${limit}`)).json(),
    ).toEqual({
      items: history.items.slice(offset, offset + limit),
      offset,
      limit,
    });
  }
  for (const entry of history.items) {
    const detail = await harness.call('GET', `/v1/history/${encodeURIComponent(entry.id)}`);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toEqual(entry);
  }
  const missing = await harness.call('GET', '/v1/history/send:missing');
  expect([missing.status, (await errorOf(missing)).code]).toEqual([404, 'not_found']);
  const legacy = await harness.call('GET', '/history?offset=1&limit=2');
  expect(legacy.status).toBe(404);
  expect(await legacy.json()).toEqual({ error: `Unknown endpoint: ${legacy.url}` });
  expect(harness.mint.requests).toEqual([]);
});
