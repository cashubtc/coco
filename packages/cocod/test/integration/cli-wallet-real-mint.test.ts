import { afterEach, describe, expect, test } from 'bun:test';
import { PaymentRequest } from '@cashu/cashu-ts';

import {
  createV1Client,
  OperationExecutionError,
  describePaymentRequest,
  payPaymentRequest,
  receiveCashu,
  requestBolt11Receive,
  sendCashu,
} from '../../src/cli-shared.js';
import {
  cleanupTransferHarnesses,
  addTransferCleanup,
  startTransferHarness,
  type TransferHarness,
} from '../helpers/transfer-harness.js';

import { startTcpTestServer } from '../helpers/tcp.js';

// Run against an isolated mintd with immediate fakewallet payment and 100ppk input fees.
// CUSTOM_UNIT selects a zero-fee custom-unit Mint for the Payment Request flow.
const mintUrl = process.env.COCOD_CLI_MINT_URL;
const unit = process.env.CUSTOM_UNIT ?? 'sat';
const fee = process.env.CUSTOM_UNIT ? 0 : 1;
afterEach(cleanupTransferHarnesses);

function client(harness: TransferHarness) {
  return createV1Client({ url: harness.url, credentialFile: harness.clientCredentialFile });
}

async function fund(harness: TransferHarness, fundingMintUrl = harness.mint.url) {
  const wallet = client(harness);
  await wallet.registerMint({ mintUrl: fundingMintUrl, trusted: true });
  if (unit === 'sat') {
    expect(await requestBolt11Receive(wallet, { amount: '64', mintUrl: fundingMintUrl })).toMatch(
      /^ln/,
    );
  } else {
    const quote = await wallet.createMintQuote({
      method: 'bolt11',
      amount: '64',
      unit,
      mintUrl: fundingMintUrl,
    });
    await wallet.prepareMint({ mintUrl: quote.mintUrl, quoteId: quote.quoteId, amount: '64' });
  }
  // Background processors are disabled in this harness. Explicitly claim the paid quote via
  // Manager; issuance is setup, while Send/Receive and Payment Requests below use the CLI flows.
  const [pending] = await harness.manager.ops.mint.listPending();
  if (!pending) throw new Error('CLI did not prepare a Mint Operation');
  let operation = await harness.manager.ops.mint.execute(pending.id);
  for (let attempt = 0; operation.state !== 'finalized' && attempt < 30; attempt++) {
    await Bun.sleep(100);
    operation = await harness.manager.ops.mint.refresh(pending.id);
    if (operation.state === 'pending')
      operation = await harness.manager.ops.mint.execute(pending.id);
  }
  expect(operation.state).toBe('finalized');
  expect(await wallet.balances()).toMatchObject({ items: [{ unit, spendable: '64' }] });
  return wallet;
}

function assertSafe(document: unknown) {
  const json = JSON.stringify(document);
  for (const field of [
    'token',
    'proofs',
    'secret',
    'C',
    'outputData',
    'inputProofSecrets',
    'request',
  ]) {
    expect(json).not.toContain(`"${field}":`);
  }
}

describe.skipIf(!mintUrl)('CLI workflows over authenticated HTTP, real Mint and SQLite', () => {
  test.skipIf(unit !== 'sat')(
    'Send -> encoded token -> Receive and operation inspection',
    async () => {
      const sender = await startTransferHarness({ mintUrl });
      const receiver = await startTransferHarness({ mintUrl });
      const sending = await fund(sender);
      const receiving = client(receiver);
      await receiving.registerMint({ mintUrl: receiver.mint.url, trusted: true });
      const token = await sendCashu(sending, { amount: '16' });
      expect(token).toMatch(/^cashu/);
      expect(await receiveCashu(receiving, token)).toBe('Received 15 sat (fee: 1 sat)');
      expect(await receiving.balances()).toMatchObject({
        items: [{ unit: 'sat', spendable: '15' }],
      });
      expect(await sending.balances()).toMatchObject({ items: [{ unit: 'sat', spendable: '47' }] });
      const history = await sending.listHistory({ offset: 0, limit: 10 });
      const entry = history.items.find((item) => item.type === 'send');
      expect(entry?.operationId).toBeTruthy();
      const operation = await sending.getOperation('send', entry!.operationId!);
      expect(operation).toMatchObject({ state: 'pending', amount: '16', fee: '1' });
      assertSafe(operation);
      assertSafe(history);
      await sender.readOnlyCredential();
      assertSafe(await sending.getOperation('send', operation.id));
      await expect(sending.executeSend(operation.id)).rejects.toMatchObject({
        status: 403,
        code: 'forbidden',
      });
    },
    30_000,
  );

  test.skipIf(unit !== 'sat')(
    'an unreadable execute response reports persisted state without repeating the Send',
    async () => {
      const sender = await startTransferHarness({ mintUrl });
      await fund(sender);
      const commands: string[] = [];
      const proxy = startTcpTestServer({
        async fetch(request) {
          const path = new URL(request.url).pathname;
          commands.push(`${request.method} ${path}`);
          const response = await fetch(new URL(path, sender.url), {
            method: request.method,
            headers: request.headers,
            ...(request.method === 'POST' ? { body: await request.text() } : {}),
          });
          if (path.endsWith('/execute')) {
            expect(response.status).toBe(200);
            await response.body!.cancel();
            // A transport boundary loses the successful body after the real Mint effect committed.
            return new Response('upstream connection lost', { status: 502 });
          }
          return response;
        },
      });
      addTransferCleanup(() => proxy.stop(true));
      const sending = sendCashu(
        createV1Client({
          url: proxy.url.toString(),
          credentialFile: sender.clientCredentialFile,
        }),
        { amount: '16' },
      );
      await expect(sending).rejects.toBeInstanceOf(OperationExecutionError);
      const [operation] = await sender.manager.ops.send.listInFlight();
      expect(operation?.state).toBe('pending');
      await expect(sending).rejects.toThrow(
        `Send Operation ${operation!.id} is pending; inspect it with`,
      );
      expect(commands).toEqual([
        'POST /v1/operations/send',
        `POST /v1/operations/send/${operation!.id}/execute`,
        `GET /v1/operations/send/${operation!.id}`,
      ]);
      expect(await client(sender).balances()).toMatchObject({ items: [{ spendable: '47' }] });
    },
    30_000,
  );

  test('Payment Request uses its unit, selects a payable Mint, and preserves receiver net value', async () => {
    const sender = await startTransferHarness();
    const receiver = await startTransferHarness({ mintUrl });
    const sending = await fund(sender, mintUrl!);
    await sending.registerMint({ mintUrl: sender.mint.url, trusted: true });
    const receiving = client(receiver);
    await receiving.registerMint({ mintUrl: receiver.mint.url, trusted: true });
    const amountless = new PaymentRequest([], 'choose-amount', undefined, unit, [
      mintUrl!,
    ]).toEncodedRequest();
    expect(await describePaymentRequest(sending, amountless)).toContain('an amount you choose');
    await expect(payPaymentRequest(sending, amountless)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await sender.manager.ops.send.listInFlight()).toHaveLength(0);
    // Fixed receiver net value can use the existing 64-unit proof directly.
    const target = 64 - fee;
    const request = new PaymentRequest([], 'cli-payment', target, unit, [
      sender.mint.url,
      mintUrl!,
    ]).toEncodedRequest();
    expect(await describePaymentRequest(sending, request)).toContain(`${target} ${unit}`);
    const output = await payPaymentRequest(sending, request);
    expect(output).toMatch(/^X-Cashu: cashu/);
    const token = output.slice('X-Cashu: '.length);
    const decoded = await sender.manager.wallet.decodeToken(token);
    expect(decoded.unit).toBe(unit);
    expect(decoded.proofs.reduce((sum, proof) => sum + Number(proof.amount), 0)).toBe(64);
    await receiveCashu(receiving, token);
    expect(await receiving.balances()).toMatchObject({
      items: [{ unit, spendable: String(target) }],
    });
    const [send] = await sender.manager.ops.send.listInFlight();
    expect(send).toMatchObject({ mintUrl, needsSwap: false });
    assertSafe(await sending.getOperation('send', send!.id));
    expect(await sender.manager.ops.send.listInFlight()).toHaveLength(1);
  }, 30_000);
});
