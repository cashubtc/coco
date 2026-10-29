import { expect, mock, test } from 'bun:test';

import {
  payBolt11Invoice,
  payPaymentRequest,
  receiveCashu,
  registerTrustedMint,
  requestBolt11Receive,
  sendCashu,
  V1ClientError,
  type V1Client,
} from '../../src/cli-shared.js';

const mintUrl = 'https://mint.example.com';

function client(overrides: Partial<V1Client>): V1Client {
  return overrides as V1Client;
}

test('send prepares in sat and then executes the prepared Send Operation', async () => {
  const prepareSend = mock(async () => ({ id: 'send-1' }));
  const executeSend = mock(async () => ({ result: { token: 'cashuBtoken' } }));

  const token = await sendCashu(
    client({ prepareSend, executeSend } as unknown as Partial<V1Client>),
    { amount: '21', mintUrl },
  );

  expect(token).toBe('cashuBtoken');
  expect(prepareSend).toHaveBeenCalledWith({ amount: '21', unit: 'sat', mintUrl });
  expect(executeSend).toHaveBeenCalledWith('send-1');
});

test('a failed execution names the prepared Operation and keeps the v1 error code', async () => {
  const failure = new V1ClientError(
    'Coco could not reach the Mint',
    502,
    'mint_unreachable',
    false,
  );

  const sending = sendCashu(
    client({
      prepareSend: async () => ({ id: 'send-1' }),
      executeSend: async () => {
        throw failure;
      },
    } as unknown as Partial<V1Client>),
    { amount: '21' },
  );

  await expect(sending).rejects.toMatchObject({
    code: 'mint_unreachable',
    status: 502,
    message: 'Coco could not reach the Mint; Send Operation send-1 was prepared',
  });
});

test('receiving over Lightning prepares the Mint Operation against the created Quote', async () => {
  const prepareMint = mock(async () => ({}));

  const invoice = await requestBolt11Receive(
    client({
      createMintQuote: async () => ({ mintUrl, quoteId: 'quote-1', request: 'lnbc1' }),
      prepareMint,
    } as unknown as Partial<V1Client>),
    { amount: '100' },
  );

  expect(invoice).toBe('lnbc1');
  expect(prepareMint).toHaveBeenCalledWith({ mintUrl, quoteId: 'quote-1', amount: '100' });
});

test('paying an invoice reports a payment that is still pending', async () => {
  const outcome = await payBolt11Invoice(
    client({
      createMeltQuote: async () => ({ mintUrl, quoteId: 'quote-1' }),
      prepareMelt: async () => ({ id: 'melt-1' }),
      executeMelt: async () => ({ operation: { id: 'melt-1', state: 'pending' } }),
    } as unknown as Partial<V1Client>),
    { invoice: 'lnbc1' },
  );

  expect(outcome).toBe('Payment pending; Melt Operation melt-1');
});

test('receiving a token, trusting a Mint, and paying a Payment Request use single resources', async () => {
  const registerMint = mock(async () => ({ mintUrl, trusted: true }));
  const prepareSend = mock(async () => ({ id: 'send-1' }));
  const wallet = client({
    prepareReceive: async () => ({ id: 'receive-1' }),
    executeReceive: async () => ({ amount: '8', unit: 'sat' }),
    registerMint,
    prepareSend,
    executeSend: async () => ({ result: { token: 'cashuBtoken' } }),
  } as unknown as Partial<V1Client>);

  expect(await receiveCashu(wallet, 'cashuBincoming')).toBe('Received 8 sat');
  await registerTrustedMint(wallet, mintUrl);
  expect(registerMint).toHaveBeenCalledWith({ mintUrl, trusted: true });
  expect(await payPaymentRequest(wallet, 'creqA1')).toBe('X-Cashu: cashuBtoken');
  expect(prepareSend).toHaveBeenCalledWith({
    source: { type: 'payment-request', request: 'creqA1' },
  });
});
