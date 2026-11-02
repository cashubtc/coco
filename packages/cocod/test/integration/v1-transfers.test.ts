import { afterEach, describe, expect, test } from 'bun:test';
import { PaymentRequest, PaymentRequestTransportType } from '@cashu/cashu-ts';
import { Amount, type SendOperation } from '@cashu/coco-core';
import { startFakeMint } from '../helpers/fake-mint.js';
import {
  startTransferHarness,
  cleanupTransferHarnesses,
  addTransferCleanup,
} from '../helpers/transfer-harness.js';

afterEach(cleanupTransferHarnesses);

// A creqB (TLV + bech32m) payment request for 21 sat carrying a P2PK NUT-10 spending condition,
// generated once with the workspace @cashu/cashu-ts.
const CREQB_P2PK_FIXTURE =
  'CREQB1QYQQ2UN9WYKNZQSQPQQQQQQQQQQQQ9GRQQQSQPQQQYQQ2QQCDP68GURN8GHJ7MTFDE6ZUETCV9KHQMR99E3K7MGXQQX8GETNWSS8QCTED4JKUAQ8QQ0QZQQPQYPQQ9MGW368QUE69UHK27RPD4CXCEFWVDHK6TMSV9USSQZFQYQQZQQZQPPRQVNP89SKXCE3V56RSCEJX4JK2ETZ8YERSWTZX5CRXVTRVV6NWERP89NX2DEJVCEKVEFJ8QMRZEPJXC6XYERRXQMNGV3S893RZVPHVFSNYU24ZDV';

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

describe('v1 transfers over a real Coco Session and SQLite', () => {
  test('report lifecycle admission failures for each transfer family before accessing core', async () => {
    const harness = await startTransferHarness();
    for (const [state, seed, status, code] of [
      ['starting', 'available', 503, 'session_transition_in_progress'],
      ['failed', 'available', 503, 'session_restart_required'],
      ['stopped', 'locked', 423, 'wallet_locked'],
      ['stopped', 'available', 503, 'session_stopped'],
    ] as const) {
      harness.setStatus({
        wallet: { configuredAt: '2026-10-29T00:00:00.000Z', mintUrl: harness.mint.url },
        seedAccess: { state: seed, requiresPassphrase: seed === 'locked' },
        cocoSession: { state, startedAt: null, lastFailure: null },
      });
      for (const [method, path, body] of [
        ['GET', '/v1/operations/send/prepared', undefined],
        ['GET', '/v1/operations/receive/prepared', undefined],
        ['POST', '/v1/payment-requests/evaluate', { request: CREQB_P2PK_FIXTURE }],
      ] as const) {
        const response = await harness.call(method, path, { body });
        expect([path, response.status, (await errorOf(response)).code]).toEqual([
          path,
          status,
          code,
        ]);
      }
    }
  });

  test('map typed Coco lifecycle errors to stable codes with details', async () => {
    const harness = await startTransferHarness();
    await harness.repositories.sendOperationRepository.create(rolledBackSend(harness.mint.url));

    const missing = await harness.call('POST', '/v1/operations/send/missing/cancel');
    expect(missing.status).toBe(404);
    expect(await errorOf(missing)).toMatchObject({
      code: 'not_found',
      details: { operationType: 'send', operationId: 'missing' },
    });

    for (const command of ['execute', 'cancel', 'refresh']) {
      const missingReceive = await harness.call(
        'POST',
        `/v1/operations/receive/missing/${command}`,
      );
      expect(missingReceive.status).toBe(404);
      expect(await errorOf(missingReceive)).toMatchObject({
        code: 'not_found',
        details: { operationType: 'receive', operationId: 'missing' },
      });
    }

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
    const harness = await startTransferHarness();
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
    expect(result.headers.get('cache-control')).toBe('no-store');
  });

  test('reject invalid parameters and request bodies before calling Coco', async () => {
    const harness = await startTransferHarness();

    const cases: Array<[string, string, unknown, string | undefined]> = [
      ['GET', '/v1/operations/send/prepared?limit=0', undefined, 'limit'],
      ['GET', '/v1/operations/receive/prepared?limit=1&limit=2', undefined, 'limit'],
      ['GET', '/v1/operations/send/prepared?unexpected=1', undefined, 'unexpected'],
      ['POST', '/v1/operations/send', { amount: '-1' }, undefined],
      ['POST', '/v1/operations/send', { amount: '18446744073709551616' }, undefined],
      ['POST', '/v1/operations/receive', { token: 'x', extra: true }, undefined],
      [
        'POST',
        '/v1/operations/send',
        { source: { type: 'payment-request', request: 'x' }, unit: 'sat' },
        undefined,
      ],
      [
        'POST',
        '/v1/operations/send',
        { amount: '1', mintUrl: 'ftp://mint.example.com' },
        undefined,
      ],
    ];
    for (const [method, path, body, parameter] of cases) {
      const response = await harness.call(method as 'GET' | 'POST', path, { body });
      const error = await errorOf(response);
      expect([path, response.status, error.code]).toEqual([path, 400, 'invalid_request']);
      if (parameter) expect(error.details).toEqual({ parameter });
    }
  });

  test('evaluate Payment Requests through Coco without exposing raw details', async () => {
    const harness = await startTransferHarness();

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

    const nostr = new PaymentRequest(
      [{ type: PaymentRequestTransportType.NOSTR, target: 'nprofile1test' }],
      'nostr-request',
      1,
      'sat',
    );
    const nostrTransport = await harness.call('POST', '/v1/operations/send', {
      body: { source: { type: 'payment-request', request: nostr.toEncodedRequest() } },
    });
    expect(nostrTransport.status).toBe(409);
    expect(await errorOf(nostrTransport)).toMatchObject({
      code: 'unsupported_behavior',
      details: { transport: 'nostr' },
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

  test('select a Mint that can pay the amount supplied for an amountless Payment Request', async () => {
    const harness = await startTransferHarness();
    const funded = startFakeMint();
    addTransferCleanup(() => funded.stop());
    const { keysets } = (await (await fetch(`${funded.url}/v1/keysets`)).json()) as {
      keysets: Array<{ id: string }>;
    };
    for (const [mintUrl, amount] of [
      [harness.mint.url, 1],
      [funded.url, 8],
    ] as const) {
      await harness.manager.mint.addMint(mintUrl, { trusted: true });
      await harness.repositories.proofRepository.saveProofs(mintUrl, [
        {
          id: keysets[0]!.id,
          amount: Amount.from(amount),
          secret: `secret-${amount}`,
          C: '02'.padEnd(66, '1'),
          mintUrl,
          unit: 'sat',
          state: 'ready',
        },
      ]);
    }
    const request = new PaymentRequest([], 'amountless', undefined, 'sat', [
      funded.url,
      harness.mint.url,
    ]).toEncodedRequest();
    const prepare = (amount: string) =>
      harness.call('POST', '/v1/operations/send', {
        body: { source: { type: 'payment-request', request }, amount },
      });

    const unaffordable = await prepare('9');
    expect(unaffordable.status).toBe(409);
    expect(await errorOf(unaffordable)).toMatchObject({ code: 'payment_request_unpayable' });

    const prepared = await prepare('8');
    expect(prepared.status).toBe(201);
    const selected = (await prepared.json()) as { id: string; mintUrl: string; amount: string };
    expect(selected).toMatchObject({ mintUrl: funded.url, amount: '8' });
    await harness.call('POST', `/v1/operations/send/${selected.id}/cancel`);
    const defaultMint = await prepare('1');
    expect(defaultMint.status).toBe(201);
    expect(await defaultMint.json()).toMatchObject({ mintUrl: harness.mint.url, amount: '1' });
    const explicit = await harness.call('POST', '/v1/operations/send', {
      body: {
        source: { type: 'payment-request', request },
        amount: '8',
        mintUrl: `${funded.url}/`,
      },
    });
    expect(explicit.status).toBe(201);
    expect(await explicit.json()).toMatchObject({ mintUrl: funded.url });
  });
});
