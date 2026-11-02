import { afterEach, describe, expect, test } from 'bun:test';
import { PaymentRequest } from '@cashu/cashu-ts';
import { Amount } from '@cashu/coco-core';

import type {
  ExecuteSendOperationResponse,
  ReceiveOperationDocument,
  SendOperationDocument,
  SendResultDocument,
} from '../../src/v1/http.js';
import {
  cleanupTransferHarnesses,
  startTransferHarness,
  type TransferHarness,
} from '../helpers/transfer-harness.js';

// Explicit opt-in keeps the default Cocod suite independent of Docker. Use the repository's
// mintd image with fakewallet, immediate quote payment and 100ppk (or zero for CUSTOM_UNIT).
const mintUrl = process.env.COCOD_TRANSFER_MINT_URL;
const unit = process.env.CUSTOM_UNIT ?? 'sat';
const fee = process.env.CUSTOM_UNIT ? 0 : 1;

afterEach(cleanupTransferHarnesses);

async function document<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body as T;
}

async function fund(harness: TransferHarness) {
  await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
  const quote = await harness.manager.quotes.mint.create({
    mintUrl: harness.mint.url,
    amount: { amount: '64', unit },
    method: 'bolt11',
  });
  const operation = await harness.manager.ops.mint.prepare({
    quote: { mintUrl: harness.mint.url, method: 'bolt11', quoteId: quote.quoteId },
    amount: '64',
  });
  let result = await harness.manager.ops.mint.execute(operation.id);
  for (let attempt = 0; result.state !== 'finalized' && attempt < 30; attempt++) {
    await Bun.sleep(100);
    result = await harness.manager.ops.mint.refresh(operation.id);
    if (result.state === 'pending') result = await harness.manager.ops.mint.execute(operation.id);
  }
  expect(result.state).toBe('finalized');
  expect((await harness.manager.wallet.balances.total({ units: [unit] })).total).toEqual(
    Amount.from(64),
  );
}

function assertSafe(value: unknown) {
  const json = JSON.stringify(value);
  for (const field of ['token', 'proofs', 'secret', 'C', 'outputData', 'inputProofSecrets']) {
    expect(json).not.toContain(`"${field}":`);
  }
}

async function prepare(harness: TransferHarness, body: unknown) {
  const operation = await document<SendOperationDocument>(
    await harness.call('POST', '/v1/operations/send', { body }),
    201,
  );
  expect(operation.state).toBe('prepared');
  assertSafe(operation);
  return operation;
}

async function execute(harness: TransferHarness, operation: SendOperationDocument) {
  const path = `/v1/operations/send/${operation.id}/execute`;
  const options = { body: {}, headers: { 'Idempotency-Key': `execute-${operation.id}` } };
  const response = await harness.call('POST', path, options);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const executed = await document<ExecuteSendOperationResponse>(response);
  expect(executed.operation.state).toBe('pending');
  assertSafe(executed.operation);
  const replay = await harness.call('POST', path, options);
  expect(replay.headers.get('cache-control')).toBe('no-store');
  expect(await document<ExecuteSendOperationResponse>(replay)).toEqual(executed);
  const result = await harness.call('GET', `/v1/operations/send/${operation.id}/result`);
  expect(result.headers.get('cache-control')).toBe('no-store');
  expect(await document<SendResultDocument>(result)).toEqual(executed.result);
  return executed.result.token;
}

async function receive(harness: TransferHarness, token: string, netAmount: number) {
  await harness.manager.mint.addMint(harness.mint.url, { trusted: true });
  const prepared = await document<ReceiveOperationDocument>(
    await harness.call('POST', '/v1/operations/receive', { body: { token } }),
    201,
  );
  expect(prepared).toMatchObject({ state: 'prepared', unit, fee: String(fee) });
  assertSafe(prepared);
  const listed = await document<{ items: ReceiveOperationDocument[] }>(
    await harness.call('GET', '/v1/operations/receive/prepared?offset=0&limit=1'),
  );
  expect(listed.items).toMatchObject([
    { id: prepared.id, state: 'prepared', amount: prepared.amount, fee: prepared.fee },
  ]);
  assertSafe(listed);
  const path = `/v1/operations/receive/${prepared.id}`;
  const options = { headers: { 'Idempotency-Key': `receive-${prepared.id}` } };
  const finalized = await document<ReceiveOperationDocument>(
    await harness.call('POST', `${path}/execute`, options),
  );
  expect(finalized).toMatchObject({ state: 'finalized', unit });
  assertSafe(finalized);
  expect(
    await document<ReceiveOperationDocument>(
      await harness.call('POST', `${path}/execute`, options),
    ),
  ).toEqual(finalized);
  expect(await document(await harness.call('GET', path))).toMatchObject({
    id: finalized.id,
    state: 'finalized',
    amount: finalized.amount,
    fee: finalized.fee,
  });
  expect(await document(await harness.call('POST', `${path}/refresh`))).toMatchObject({
    id: finalized.id,
    state: 'finalized',
  });
  expect(
    await document(await harness.call('GET', '/v1/operations/receive/in-flight')),
  ).toMatchObject({ items: [] });
  expect((await harness.manager.wallet.balances.total({ units: [unit] })).total).toEqual(
    Amount.from(netAmount),
  );
  expect(await harness.manager.history.getPaginatedHistory()).toContainEqual(
    expect.objectContaining({ type: 'receive', operationId: prepared.id }),
  );
  const invalid = await harness.call('POST', `${path}/cancel`);
  expect(await document(invalid, 409)).toMatchObject({
    error: { code: 'invalid_operation_state' },
  });
}

describe.skipIf(!mintUrl)('v1 funded transfers with real Mint, core and SQLite', () => {
  test.each([false, true])(
    'Send -> token -> Receive (forceSwap=%s)',
    async (forceSwap) => {
      const sender = await startTransferHarness({ mintUrl });
      const receiver = await startTransferHarness({ mintUrl });
      await fund(sender);
      const amount = forceSwap ? 16 : 64;
      const prepared = await prepare(sender, { amount: String(amount), unit, forceSwap });
      expect(prepared).toMatchObject({
        mintUrl,
        amount: String(amount),
        needsSwap: forceSwap,
        fee: String(forceSwap ? fee : 0),
      });
      const token = await execute(sender, prepared);
      await receive(receiver, token, amount - fee);
      const refreshed = await document<SendOperationDocument>(
        await sender.call('POST', `/v1/operations/send/${prepared.id}/refresh`),
      );
      expect(refreshed.state).toBe('finalized');
      assertSafe(refreshed);
      expect((await sender.manager.wallet.balances.total({ units: [unit] })).total).toEqual(
        Amount.from(64 - amount - (forceSwap ? fee : 0)),
      );
      expect(await sender.manager.history.getPaginatedHistory()).toContainEqual(
        expect.objectContaining({ type: 'send', operationId: prepared.id }),
      );

      await sender.readOnlyCredential();
      expect((await sender.call('GET', `/v1/operations/send/${prepared.id}`)).status).toBe(200);
      for (const [method, suffix] of [
        ['GET', 'result'],
        ['POST', 'execute'],
      ] as const) {
        const forbidden = await sender.call(
          method,
          `/v1/operations/send/${prepared.id}/${suffix}`,
          {
            headers: { 'Idempotency-Key': `execute-${prepared.id}` },
          },
        );
        expect(forbidden.headers.get('cache-control')).toBe('no-store');
        expect(await document(forbidden, 403)).toMatchObject({ error: { code: 'forbidden' } });
      }
    },
    30_000,
  );

  test.each([false, true])(
    'in-band Payment Request preserves receiver net value (amountless=%s)',
    async (amountless) => {
      const sender = await startTransferHarness({ mintUrl });
      const receiver = await startTransferHarness({ mintUrl });
      await fund(sender);
      // A fixed net request of 63 sat can use the existing 64-sat proof directly at 100ppk.
      // The amountless 16-unit request requires a swap and funds the receiver's input fee.
      const target = amountless ? 16 : 64 - fee;
      const request = new PaymentRequest(
        [],
        'http-payment',
        amountless ? undefined : target,
        unit,
        [mintUrl!],
      ).toEncodedRequest();
      const evaluation = await document(
        await sender.call('POST', '/v1/payment-requests/evaluate', { body: { request } }),
      );
      expect(evaluation).toMatchObject({
        unit,
        transport: { type: 'inband' },
        payableMints: [mintUrl],
      });
      const prepared = await prepare(sender, {
        source: { type: 'payment-request', request },
        ...(amountless ? { amount: String(target), unit } : {}),
      });
      expect(prepared).toMatchObject({
        mintUrl,
        amount: String(target + fee),
        needsSwap: amountless,
        fee: String(amountless ? fee : 0),
      });
      const token = await execute(sender, prepared);
      const decoded = await sender.manager.wallet.decodeToken(token);
      expect(decoded.unit).toBe(unit);
      expect(decoded.proofs.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(
        target + fee,
      );
      await receive(receiver, token, target);
    },
    30_000,
  );

  test('cancel releases reservations, Receive cancel leaves token spendable, and Send reclaim recovers it', async () => {
    const sender = await startTransferHarness({ mintUrl });
    const receiver = await startTransferHarness({ mintUrl });
    await fund(sender);
    await receiver.manager.mint.addMint(mintUrl!, { trusted: true });
    const first = await prepare(sender, { amount: '16', unit });
    const unavailable = await sender.call('GET', `/v1/operations/send/${first.id}/result`);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    expect(await document(unavailable, 409)).toMatchObject({
      error: { code: 'operation_result_not_available' },
    });
    expect(
      await document(await sender.call('POST', `/v1/operations/send/${first.id}/cancel`)),
    ).toMatchObject({ state: 'rolled_back' });
    expect((await sender.manager.wallet.balances.total({ units: [unit] })).spendable).toEqual(
      Amount.from(64),
    );
    const second = await prepare(sender, { amount: '16', unit, forceSwap: true });
    const token = await execute(sender, second);
    const incoming = await document<ReceiveOperationDocument>(
      await receiver.call('POST', '/v1/operations/receive', { body: { token } }),
      201,
    );
    expect(
      await document(await receiver.call('POST', `/v1/operations/receive/${incoming.id}/cancel`)),
    ).toMatchObject({ state: 'rolled_back' });
    expect((await receiver.manager.wallet.balances.total({ units: [unit] })).total).toEqual(
      Amount.zero(),
    );
    expect(
      await document(await sender.call('POST', `/v1/operations/send/${second.id}/reclaim`)),
    ).toMatchObject({ state: 'rolled_back' });
    expect((await sender.manager.wallet.balances.total({ units: [unit] })).spendable).toEqual(
      Amount.from(64 - 2 * fee),
    );
    expect(await document(await sender.call('GET', '/v1/operations/send/in-flight'))).toMatchObject(
      { items: [] },
    );
  }, 30_000);
});
