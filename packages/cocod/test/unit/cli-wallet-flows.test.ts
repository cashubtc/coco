import { expect, mock, test } from 'bun:test';

import {
  OperationExecutionError,
  payBolt11Invoice,
  payPaymentRequest,
  receiveCashu,
  requestBolt11Receive,
  sendCashu,
  V1ClientError,
  watchHistory,
  type V1Client,
} from '../../src/cli-shared.js';
import type { HistoryDocument, ResourceEventDocument } from '../../src/v1/http.js';

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

test('a failed execution offers cancellation only while the Operation is still prepared', async () => {
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
      getOperation: async () => ({ id: 'send-1', state: 'prepared' }),
    } as unknown as Partial<V1Client>),
    { amount: '21' },
  );

  await expect(sending).rejects.toMatchObject({
    code: 'mint_unreachable',
    status: 502,
    message:
      'Coco could not reach the Mint; Send Operation send-1 is still prepared; inspect it with ' +
      '`cocod operations show send send-1` or cancel it with `cocod operations cancel send send-1`',
  });
});

test('a failed execution reports the state the Operation actually reached', async () => {
  const getOperation = mock(async () => ({ id: 'melt-1', state: 'executing' }));

  const paying = payBolt11Invoice(
    client({
      createMeltQuote: async () => ({ mintUrl, quoteId: 'quote-1' }),
      prepareMelt: async () => ({ id: 'melt-1' }),
      executeMelt: async () => {
        throw new V1ClientError('Coco could not reach the Mint', 502, 'mint_unreachable', false);
      },
      getOperation,
    } as unknown as Partial<V1Client>),
    { invoice: 'lnbc1' },
  );

  await expect(paying).rejects.toMatchObject({
    message:
      'Coco could not reach the Mint; Melt Operation melt-1 is executing; inspect it with ' +
      '`cocod operations show melt melt-1`',
  });
  expect(getOperation).toHaveBeenCalledWith('melt', 'melt-1');
});

test('a dropped connection still names the Operation when its state cannot be read', async () => {
  const closed = new Error('The socket connection was closed unexpectedly.');

  const paying = payBolt11Invoice(
    client({
      createMeltQuote: async () => ({ mintUrl, quoteId: 'quote-1' }),
      prepareMelt: async () => ({ id: 'melt-1' }),
      executeMelt: async () => {
        throw closed;
      },
      getOperation: async () => {
        throw new Error('fetch failed');
      },
    } as unknown as Partial<V1Client>),
    { invoice: 'lnbc1' },
  );

  await expect(paying).rejects.toBeInstanceOf(OperationExecutionError);
  await expect(paying).rejects.toMatchObject({
    cause: closed,
    message:
      'The socket connection was closed unexpectedly.; the state of Melt Operation melt-1 could ' +
      'not be read; inspect it with `cocod operations show melt melt-1`',
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

test('receiving a token and paying a Payment Request use single resources', async () => {
  const prepareSend = mock(async () => ({ id: 'send-1' }));
  const wallet = client({
    prepareReceive: async () => ({ id: 'receive-1' }),
    executeReceive: async () => ({ amount: '8', unit: 'sat' }),
    prepareSend,
    executeSend: async () => ({ result: { token: 'cashuBtoken' } }),
  } as unknown as Partial<V1Client>);

  expect(await receiveCashu(wallet, 'cashuBincoming')).toBe('Received 8 sat');
  expect(await payPaymentRequest(wallet, 'creqA1')).toBe('X-Cashu: cashuBtoken');
  expect(prepareSend).toHaveBeenCalledWith({
    source: { type: 'payment-request', request: 'creqA1' },
  });
});

function historyEntry(id: string, state: string): HistoryDocument {
  return {
    id,
    type: 'send',
    source: 'operation',
    state,
    mintUrl,
    unit: 'sat',
    amount: '1',
    createdAt: '2026-10-29T00:00:00.000Z',
    updatedAt: '2026-10-29T00:00:00.000Z',
  };
}

const sessionStopped = new V1ClientError(
  'The Coco Session is stopped',
  503,
  'session_stopped',
  false,
);

test('watching history refetches an invalidated entry instead of trusting the event', async () => {
  const seen: HistoryDocument[] = [];
  const entries = new Map([['send:1', historyEntry('send:1', 'finalized')]]);
  const getHistoryEntry = mock(async (id: string) => entries.get(id)!);
  let connections = 0;

  const watching = watchHistory(
    client({
      listHistory: async () => ({
        items: [historyEntry('send:1', 'pending')],
        offset: 0,
        limit: 5,
      }),
      getHistoryEntry,
      watchEvents: async (
        onEvent: (event: ResourceEventDocument) => void,
        options?: { onOpen?: () => void },
      ) => {
        if (++connections > 1) throw sessionStopped;
        options?.onOpen?.();
        onEvent({
          type: 'history.updated',
          timestamp: '2026-10-29T00:00:00.000Z',
          data: historyEntry('send:1', 'stale-event-payload'),
        });
      },
    } as unknown as Partial<V1Client>),
    [historyEntry('send:1', 'pending')],
    { limit: 5, onEntry: (entry) => seen.push(entry), reconnectDelayMs: 0 },
  );

  await expect(watching).rejects.toBe(sessionStopped);
  expect(getHistoryEntry).toHaveBeenCalledWith('send:1');
  expect(seen).toEqual([historyEntry('send:1', 'finalized')]);
});

test('watching history reconnects after a disconnect and reports what it missed once', async () => {
  const seen: string[] = [];
  const disconnects = mock(() => {});
  const items = [historyEntry('send:2', 'finalized'), historyEntry('send:1', 'pending')];
  let connections = 0;

  const watching = watchHistory(
    client({
      listHistory: async () => ({ items, offset: 0, limit: 5 }),
      watchEvents: async (_onEvent: unknown, options?: { onOpen?: () => void }) => {
        connections += 1;
        if (connections === 1) throw new Error('The socket connection was closed unexpectedly.');
        if (connections === 4) throw sessionStopped;
        options?.onOpen?.();
      },
    } as unknown as Partial<V1Client>),
    [historyEntry('send:1', 'pending')],
    {
      limit: 5,
      onEntry: (entry) => seen.push(entry.id),
      onDisconnect: disconnects,
      reconnectDelayMs: 0,
    },
  );

  await expect(watching).rejects.toBe(sessionStopped);
  expect(seen).toEqual(['send:2']);
  expect(disconnects).toHaveBeenCalledTimes(3);
});

test('watching history reconnects after a retryable refetch failure', async () => {
  const seen: string[] = [];
  let reads = 0;
  let connections = 0;

  const watching = watchHistory(
    client({
      listHistory: async () => {
        reads += 1;
        if (reads === 1)
          throw new V1ClientError('Busy', 503, 'session_transition_in_progress', true);
        return { items: [historyEntry('send:3', 'finalized')], offset: 0, limit: 5 };
      },
      watchEvents: async (_onEvent: unknown, options?: { onOpen?: () => void }) => {
        if (++connections > 2) throw sessionStopped;
        options?.onOpen?.();
      },
    } as unknown as Partial<V1Client>),
    [],
    { limit: 5, onEntry: (entry) => seen.push(entry.id), reconnectDelayMs: 0 },
  );

  await expect(watching).rejects.toBe(sessionStopped);
  expect(seen).toEqual(['send:3']);
});
