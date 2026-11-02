import { afterEach, describe, expect, test } from 'bun:test';
import { createFakeInvoice } from 'fake-bolt11';

import type {
  ExecuteMeltOperationResponse,
  MeltOperationDocument,
  MeltQuoteDocument,
  MintOperationDocument,
  MintQuoteDocument,
  MeltResultDocument,
  PageDocument,
} from '../../src/v1/http.js';
import {
  cleanupQuoteHarnesses,
  errorOf,
  startQuoteHarness,
  type QuoteOperationHarness,
} from '../helpers/quote-operations.js';

const mintUrl = process.env.COCOD_TEST_MINT_URL;
afterEach(cleanupQuoteHarnesses);

async function document<T = object>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body as T;
}

// SQL repositories persist operation timestamps at second precision.
function persisted<T extends { createdAt: string; updatedAt: string }>(operation: T): T {
  return {
    ...operation,
    createdAt: operation.createdAt.replace(/\.\d{3}Z$/, '.000Z'),
    updatedAt: operation.updatedAt.replace(/\.\d{3}Z$/, '.000Z'),
  };
}

function expectSafe(value: unknown) {
  const forbidden = [
    'proofs',
    'secret',
    'inputProofSecrets',
    'outputData',
    'changeOutputData',
    'swapOutputData',
    'methodData',
    'finalizedData',
    'preimage',
    'token',
    'error',
  ];
  function visit(node: unknown) {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      expect(forbidden).not.toContain(key);
      visit(child);
    }
  }
  visit(value);
}

async function issue(harness: QuoteOperationHarness, amount = '128') {
  const quote = await document<MintQuoteDocument>(
    await harness.call('POST', '/v1/quotes/mint', {
      body: { method: 'bolt11', amount },
    }),
    201,
  );
  const input = { mintUrl: harness.mint.url, quoteId: quote.quoteId, amount };
  const prepare = () =>
    harness.call('POST', '/v1/operations/mint', {
      body: input,
      headers: { 'Idempotency-Key': `prepare-${quote.quoteId}` },
    });
  const prepared = await document<MintOperationDocument>(await prepare(), 201);
  expect(prepared.state).toBe('pending');
  expect(await document<MintOperationDocument>(await prepare(), 201)).toEqual(prepared);
  expect((await harness.manager.wallet.balances.total()).total.toString()).toBe('0');
  expectSafe(prepared);

  // The isolated CDK fakewallet settles automatically; wait on canonical HTTP observations.
  let paid = quote;
  for (let attempt = 0; paid.state !== 'PAID' && attempt < 50; attempt++) {
    paid = await document<MintQuoteDocument>(
      await harness.call(
        'POST',
        `/v1/quotes/mint/${quote.quoteId}/refresh?mintUrl=${encodeURIComponent(harness.mint.url)}`,
      ),
    );
    if (paid.state !== 'PAID') await Bun.sleep(100);
  }
  expect(paid.state).toBe('PAID');
  const execute = () =>
    harness.call('POST', `/v1/operations/mint/${prepared.id}/execute`, {
      body: {},
      headers: { 'Idempotency-Key': `execute-${prepared.id}` },
    });
  const issued = await document<MintOperationDocument>(await execute());
  expect(issued).toMatchObject({ id: prepared.id, state: 'finalized', amount });
  expectSafe(issued);
  expect(await document<MintOperationDocument>(await execute())).toEqual(issued);
  expect((await harness.manager.wallet.balances.total()).total.toString()).toBe(amount);
  expect((await harness.manager.ops.mint.get(prepared.id))?.state).toBe('finalized');
  expect(
    await document<MintOperationDocument>(
      await harness.call('GET', `/v1/operations/mint/${prepared.id}`),
    ),
  ).toEqual(persisted(issued));
  expect(
    await document<MintOperationDocument>(
      await harness.call('POST', `/v1/operations/mint/${prepared.id}/refresh`),
    ),
  ).toEqual(persisted(issued));
  const history = await harness.manager.history.getPaginatedHistory();
  expect(history.filter((entry) => entry.operationId === prepared.id)).toHaveLength(1);
  return issued;
}

async function meltQuote(harness: QuoteOperationHarness) {
  return document<MeltQuoteDocument>(
    await harness.call('POST', '/v1/quotes/melt', {
      body: { method: 'bolt11', invoice: createFakeInvoice(20) },
    }),
    201,
  );
}

async function prepareMelt(harness: QuoteOperationHarness, quote: MeltQuoteDocument) {
  const prepare = () =>
    harness.call('POST', '/v1/operations/melt', {
      body: { mintUrl: harness.mint.url, quoteId: quote.quoteId },
      headers: { 'Idempotency-Key': `prepare-${quote.quoteId}` },
    });
  const operation = await document<MeltOperationDocument>(await prepare(), 201);
  expect(await document<MeltOperationDocument>(await prepare(), 201)).toEqual(operation);
  expect(operation).toMatchObject({ state: 'prepared', amount: '20' });
  expectSafe(operation);
  return operation;
}

describe.skipIf(!mintUrl)('v1 Quote-backed Operations with an isolated real Mint', () => {
  test('issues paid BOLT11 proofs and executes a Melt through HTTP with protected results', async () => {
    const harness = await startQuoteHarness({ mintUrl });
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
    await issue(harness);
    const quote = await meltQuote(harness);
    expectSafe(quote);
    const identity = `${quote.quoteId}?mintUrl=${encodeURIComponent(harness.mint.url)}`;
    expect(
      await document<MeltQuoteDocument>(await harness.call('GET', `/v1/quotes/melt/${identity}`)),
    ).toEqual(quote);
    expect(
      await document<PageDocument<MeltQuoteDocument>>(
        await harness.call('GET', '/v1/quotes/melt/pending?method=bolt11'),
      ),
    ).toMatchObject({ items: [expect.objectContaining({ quoteId: quote.quoteId })] });
    const operation = await prepareMelt(harness, quote);
    const before = await harness.manager.wallet.balances.total();
    expect(before.total.toString()).toBe('128');
    expect(before.reserved.toNumber()).toBeGreaterThan(0);
    const unavailable = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(unavailable.status).toBe(409);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    expect(await errorOf(unavailable)).toMatchObject({
      code: 'operation_result_not_available',
      retryable: false,
      details: { operationType: 'melt', operationId: operation.id, state: 'prepared' },
    });
    const execute = () =>
      harness.call('POST', `/v1/operations/melt/${operation.id}/execute`, {
        headers: { 'Idempotency-Key': `execute-${operation.id}` },
      });
    const response = await execute();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const executed = await document<ExecuteMeltOperationResponse>(response);
    expect(executed.operation).toMatchObject({ id: operation.id, state: 'finalized' });
    expectSafe(executed.operation);
    // CDK 0.17 fakewallet returns an empty BOLT11 payment proof, which is not a result.
    expect(executed.result).toBeUndefined();
    expect(await document<ExecuteMeltOperationResponse>(await execute())).toEqual(executed);
    const stored = await harness.manager.ops.melt.get(operation.id);
    expect(stored?.state).toBe('finalized');
    if (stored?.state !== 'finalized') throw new Error('Melt did not finalize');
    expect(stored.finalizedData?.preimage ?? '').toBe('');
    const after = await harness.manager.wallet.balances.total();
    expect(after.reserved.toString()).toBe('0');
    expect(after.total).toEqual(
      before.total.subtract(stored.amount).subtract(stored.swap_fee).subtract(stored.effectiveFee!),
    );
    expect(await harness.manager.history.getPaginatedHistory()).toContainEqual(
      expect.objectContaining({ type: 'melt', operationId: operation.id }),
    );
    const result = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.status).toBe(409);
    expect(await errorOf(result)).toMatchObject({
      code: 'operation_result_not_available',
      retryable: false,
    });
    const refreshed = await document<MeltQuoteDocument>(
      await harness.call(
        'POST',
        `/v1/quotes/melt/${quote.quoteId}/refresh?mintUrl=${encodeURIComponent(harness.mint.url)}`,
      ),
    );
    expect(refreshed.state).toBe('PAID');
    expectSafe(refreshed);
    expect(
      await document<MeltOperationDocument>(
        await harness.call('POST', `/v1/operations/melt/${operation.id}/refresh`),
      ),
    ).toEqual(persisted(executed.operation));
    const repeat = await harness.call('POST', `/v1/operations/melt/${operation.id}/execute`);
    expect(repeat.status).toBe(409);
    expect(repeat.headers.get('cache-control')).toBe('no-store');
    expect(await errorOf(repeat)).toMatchObject({
      code: 'invalid_operation_state',
      details: {
        operationType: 'melt',
        operationId: operation.id,
        state: 'finalized',
        expectedStates: ['prepared'],
      },
    });
    await harness.readOnlyCredential();
    const readable = await document<MeltOperationDocument>(
      await harness.call('GET', `/v1/operations/melt/${operation.id}`),
    );
    expect(readable).toEqual(persisted(executed.operation));
    expectSafe(readable);
    const forbidden = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get('cache-control')).toBe('no-store');
    expect((await execute()).status).toBe(403); // Re-authorization precedes cached payment results.
  }, 30_000);

  test('cancels reserved Melt proofs, rejects invalid commands and BOLT fee selection', async () => {
    const harness = await startQuoteHarness({ mintUrl });
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
    await issue(harness);
    const quote = await meltQuote(harness);
    const invalidFee = await harness.call('POST', '/v1/operations/melt', {
      body: { mintUrl: harness.mint.url, quoteId: quote.quoteId, feeIndex: 0 },
    });
    expect(invalidFee.status).toBe(400);
    expect(await errorOf(invalidFee)).toMatchObject({
      code: 'invalid_request',
      details: { field: 'feeIndex' },
    });
    expect((await harness.manager.wallet.balances.total()).reserved.toString()).toBe('0');
    const operation = await prepareMelt(harness, quote);
    expect(
      await document<PageDocument<MeltOperationDocument>>(
        await harness.call('GET', '/v1/operations/melt/prepared?limit=1'),
      ),
    ).toMatchObject({
      items: [expect.objectContaining({ id: operation.id })],
      offset: 0,
      limit: 1,
    });
    const reclaim = await harness.call('POST', `/v1/operations/melt/${operation.id}/reclaim`);
    expect(reclaim.status).toBe(409);
    expect(await errorOf(reclaim)).toMatchObject({ code: 'invalid_operation_state' });
    const cancel = () =>
      harness.call('POST', `/v1/operations/melt/${operation.id}/cancel`, {
        body: {},
        headers: { 'Idempotency-Key': `cancel-${operation.id}` },
      });
    const cancelled = await document<MeltOperationDocument>(await cancel());
    expect(cancelled.state).toBe('rolled_back');
    expectSafe(cancelled);
    expect(await document<MeltOperationDocument>(await cancel())).toEqual(cancelled);
    const after = await harness.manager.wallet.balances.total();
    expect(after.total.toString()).toBe('128');
    expect(after.reserved.toString()).toBe('0');
    for (const command of ['execute', 'cancel', 'reclaim']) {
      const invalid = await harness.call('POST', `/v1/operations/melt/${operation.id}/${command}`);
      expect(invalid.status).toBe(409);
      expect(await errorOf(invalid)).toMatchObject({
        code: 'invalid_operation_state',
        details: {
          operationType: 'melt',
          operationId: operation.id,
          state: 'rolled_back',
        },
      });
    }
    const result = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(result.status).toBe(409);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await errorOf(result)).toMatchObject({
      code: 'operation_result_not_available',
      retryable: false,
    });
  }, 30_000);
});

test.skipIf(!mintUrl)(
  'v1 real Mint returns an on-chain Melt outpoint only on administrative result routes',
  async () => {
    const harness = await startQuoteHarness({ mintUrl });
    await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
    await issue(harness, '8192');
    const quote = await document<MeltQuoteDocument>(
      await harness.call('POST', '/v1/quotes/melt', {
        body: {
          method: 'onchain',
          address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
          amountSats: '1000',
        },
      }),
      201,
    );
    expect(quote.method).toBe('onchain');
    expect(quote.feeOptions?.length).toBeGreaterThan(0);
    for (const feeIndex of [undefined, 999999]) {
      const invalid = await harness.call('POST', '/v1/operations/melt', {
        body: {
          mintUrl: harness.mint.url,
          quoteId: quote.quoteId,
          ...(feeIndex !== undefined ? { feeIndex } : {}),
        },
      });
      expect(invalid.status).toBe(400);
      expect(await errorOf(invalid)).toMatchObject({ code: 'invalid_request' });
    }
    const feeIndex = quote.feeOptions![0]!.feeIndex;
    const operation = await document<MeltOperationDocument>(
      await harness.call('POST', '/v1/operations/melt', {
        body: { mintUrl: harness.mint.url, quoteId: quote.quoteId, feeIndex },
      }),
      201,
    );
    expect(operation).toMatchObject({ state: 'prepared', method: 'onchain', feeIndex });
    expectSafe(operation);
    const execute = () =>
      harness.call('POST', `/v1/operations/melt/${operation.id}/execute`, {
        headers: { 'Idempotency-Key': `onchain-${operation.id}` },
      });
    const response = await execute();
    expect(response.headers.get('cache-control')).toBe('no-store');
    const executed = await document<ExecuteMeltOperationResponse>(response);
    expect(await document<ExecuteMeltOperationResponse>(await execute())).toEqual(executed);
    let settled = executed.operation;
    for (let attempt = 0; settled.state !== 'finalized' && attempt < 50; attempt++) {
      if (settled.state === 'pending') {
        const pendingResult = await harness.call(
          'GET',
          `/v1/operations/melt/${operation.id}/result`,
        );
        expect(pendingResult.status).toBe(409);
        expect(await errorOf(pendingResult)).toMatchObject({
          code: 'operation_result_not_available',
          retryable: true,
        });
      }
      await Bun.sleep(100);
      settled = await document<MeltOperationDocument>(
        await harness.call('POST', `/v1/operations/melt/${operation.id}/refresh`),
      );
    }
    expect(settled.state).toBe('finalized');
    const paymentResult = await document<MeltResultDocument>(
      await harness.call('GET', `/v1/operations/melt/${operation.id}/result`),
    );
    expect(paymentResult).toEqual({ outpoint: expect.any(String) });
    expect((paymentResult as { outpoint: string }).outpoint.length).toBeGreaterThan(0);
    expectSafe(executed.operation);
    expect(await document<ExecuteMeltOperationResponse>(await execute())).toEqual(executed);
    const stored = await harness.manager.ops.melt.get(operation.id);
    if (stored?.state !== 'finalized') throw new Error('Expected a finalized on-chain Melt');
    expect(paymentResult).toEqual({ outpoint: stored.finalizedData?.outpoint! });
    const result = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await document<MeltResultDocument>(result)).toEqual(paymentResult);
    const balance = await harness.manager.wallet.balances.total();
    expect(balance.reserved.toString()).toBe('0');
    expect(balance.total.toBigInt()).toBe(
      8192n -
        stored.amount.toBigInt() -
        stored.swap_fee.toBigInt() -
        stored.effectiveFee!.toBigInt(),
    );
    await harness.readOnlyCredential();
    expectSafe(
      await document<MeltOperationDocument>(
        await harness.call('GET', `/v1/operations/melt/${operation.id}`),
      ),
    );
    const denied = await harness.call('GET', `/v1/operations/melt/${operation.id}/result`);
    expect(denied.status).toBe(403);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect((await execute()).status).toBe(403);
  },
  30_000,
);
