import { expect, spyOn, test } from 'bun:test';
import type { Manager } from '@cashu/coco-core';

import { resourceEventSchema } from '../../src/v1/resources/event-schemas.js';
import { createResourceEventStream, EVENT_BUFFER_LIMIT } from '../../src/v1/resources/events.js';

/** Records Coco subscriptions so tests can publish events and observe unsubscription. */
function fakeEventSource() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    manager: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = listeners.get(event) ?? new Set();
        set.add(handler);
        listeners.set(event, set);
        return () => set.delete(handler);
      },
    } as unknown as Pick<Manager, 'on'>,
    emit(event: string, payload: unknown) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    subscriptionCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  return chunks;
}

function streamOptions(source: ReturnType<typeof fakeEventSource>, overrides = {}) {
  return {
    manager: source.manager,
    signal: new AbortController().signal,
    reauthorize: async () => true,
    isCurrentSession: () => true,
    keepAliveIntervalMs: 60_000,
    ...overrides,
  };
}

test('a client that stops reading is disconnected once its buffer is full', async () => {
  const source = fakeEventSource();
  const stream = createResourceEventStream(streamOptions(source));

  for (let index = 0; index < EVENT_BUFFER_LIMIT * 2; index++) {
    source.emit('mint:trusted', { mintUrl: `https://mint${index}.example.com` });
  }

  expect(source.subscriptionCount()).toBe(0);
  const chunks = await readAll(stream);
  expect(chunks.length).toBe(EVENT_BUFFER_LIMIT);
  expect(chunks[0]).toBe(': connected\n\n');
  expect(chunks[1]).toContain('"type":"mint.updated"');
});

test('a revoked Client Credential ends the stream at the next keep-alive', async () => {
  const source = fakeEventSource();
  const stream = createResourceEventStream(
    streamOptions(source, { reauthorize: async () => false, keepAliveIntervalMs: 5 }),
  );

  expect(await readAll(stream)).toEqual([': connected\n\n']);
  expect(source.subscriptionCount()).toBe(0);
});

test('a client disconnect releases every Coco subscription', async () => {
  const source = fakeEventSource();
  const abort = new AbortController();
  const stream = createResourceEventStream(streamOptions(source, { signal: abort.signal }));
  expect(source.subscriptionCount()).toBeGreaterThan(0);

  abort.abort();

  expect(source.subscriptionCount()).toBe(0);
  expect(await readAll(stream)).toEqual([': connected\n\n']);
});

test('events published after the Coco Session changes close the stream instead', async () => {
  const source = fakeEventSource();
  let current = true;
  const stream = createResourceEventStream(
    streamOptions(source, { isCurrentSession: () => current }),
  );

  source.emit('proofs:saved', { mintUrl: 'https://mint.example.com' });
  current = false;
  source.emit('proofs:saved', { mintUrl: 'https://mint.example.com' });

  const chunks = await readAll(stream);
  expect(chunks).toHaveLength(2);
  expect(JSON.parse(chunks[1]!.slice('data: '.length))).toMatchObject({
    type: 'balance.updated',
    data: { mintUrl: 'https://mint.example.com' },
  });
  expect(source.subscriptionCount()).toBe(0);
});

test('history invalidations carry the safe history document without the token', async () => {
  const source = fakeEventSource();
  const abort = new AbortController();
  const stream = createResourceEventStream(streamOptions(source, { signal: abort.signal }));

  source.emit('history:updated', {
    mintUrl: 'https://mint.example.com',
    entry: {
      id: 'send:op-1',
      source: 'operation',
      operationId: 'op-1',
      type: 'send',
      state: 'pending',
      mintUrl: 'https://mint.example.com',
      unit: 'sat',
      amount: { toString: () => '5' },
      token: { mint: 'https://mint.example.com', proofs: [{ secret: 'bearer-secret' }] },
      metadata: { memo: 'private' },
      createdAt: 1_000,
      updatedAt: 2_000,
    },
  });
  abort.abort();

  const text = (await readAll(stream)).join('');
  expect(text).toContain('"id":"send:op-1"');
  expect(text).not.toContain('bearer-secret');
  expect(text).not.toContain('private');
});

/** Manual transport clock; tests control ticks and authorization completion independently. */
function manualInterval() {
  let callback: (() => void) | undefined;
  const timer = 1 as unknown as ReturnType<typeof setInterval>;
  // The transport uses only the callback overload; Bun and Node expose different timer types.
  const set = spyOn(globalThis, 'setInterval').mockImplementation(((handler: () => void) => {
    callback = handler;
    return timer;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {
    callback = undefined;
  });
  return {
    tick: () => callback?.(),
    active: () => callback !== undefined,
    restore: () => {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}

test('cancellation releases subscriptions and the timer while authorization is pending', async () => {
  const clock = manualInterval();
  const source = fakeEventSource();
  const authorization = Promise.withResolvers<boolean>();
  let checks = 0;
  try {
    const stream = createResourceEventStream(
      streamOptions(source, {
        reauthorize: () => {
          checks++;
          return authorization.promise;
        },
      }),
    );
    clock.tick();
    clock.tick();
    expect(checks).toBe(1);
    await stream.cancel();
    expect(source.subscriptionCount()).toBe(0);
    expect(clock.active()).toBe(false);
    authorization.resolve(true);
    await authorization.promise;
    source.emit('mint:trusted', { mintUrl: 'https://mint.example.com' });
    expect(await readAll(stream)).toEqual([]);
    clock.tick();
    expect(checks).toBe(1);
  } finally {
    clock.restore();
  }
});

test('authorization failure and an idle session replacement both release the stream', async () => {
  for (const failure of ['credential', 'session'] as const) {
    const clock = manualInterval();
    const source = fakeEventSource();
    let current = true;
    let checks = 0;
    try {
      const stream = createResourceEventStream(
        streamOptions(source, {
          isCurrentSession: () => current,
          reauthorize: async () => {
            checks++;
            throw new Error('verifier unavailable');
          },
        }),
      );
      current = failure !== 'session';
      clock.tick();
      expect(await readAll(stream)).toEqual([': connected\n\n']);
      expect(source.subscriptionCount()).toBe(0);
      expect(clock.active()).toBe(false);
      expect(checks).toBe(failure === 'credential' ? 1 : 0);
    } finally {
      clock.restore();
    }
  }
});

test('an already aborted request releases its subscriptions and timer', async () => {
  const source = fakeEventSource();
  const clock = manualInterval();
  try {
    const stream = createResourceEventStream(
      streamOptions(source, { signal: AbortSignal.abort() }),
    );
    expect(source.subscriptionCount()).toBe(0);
    expect(clock.active()).toBe(false);
    expect(await readAll(stream)).toEqual([': connected\n\n']);
  } finally {
    clock.restore();
  }
});

test('resource projections discard quote, operation and proof secrets before schema validation', async () => {
  const source = fakeEventSource();
  const stream = createResourceEventStream(streamOptions(source));
  const mintUrl = 'https://mint.example.com';
  const sensitive = {
    token: 'bearer',
    preimage: 'preimage-secret',
    secret: 'proof-secret',
    metadata: { memo: 'private' },
  };
  source.emit('melt-quote:updated', {
    mintUrl,
    method: 'bolt11',
    quoteId: 'quote-1',
    ...sensitive,
  });
  source.emit('send:pending', { mintUrl, operationId: 'operation-1', ...sensitive });
  source.emit('proofs:reserved', { mintUrl, ...sensitive });
  const reader = stream.getReader();
  await reader.read();
  const expected = [
    {
      type: 'quote.updated',
      data: { quoteType: 'melt', mintUrl, method: 'bolt11', quoteId: 'quote-1' },
    },
    {
      type: 'operation.updated',
      data: { operationType: 'send', mintUrl, operationId: 'operation-1' },
    },
    { type: 'balance.updated', data: { mintUrl } },
  ] as const;
  for (const projection of expected) {
    const { value } = await reader.read();
    const event = resourceEventSchema.parse(JSON.parse(new TextDecoder().decode(value).slice(6)));
    expect(event).toEqual({ ...projection, timestamp: expect.any(String) });
  }
  await reader.cancel();
  expect(source.subscriptionCount()).toBe(0);
});

test('event schemas reject unknown fields, invalid timestamps and malformed identities', () => {
  const event = {
    type: 'operation.updated',
    timestamp: '2026-10-29T00:00:00.000Z',
    data: { operationType: 'send', mintUrl: 'https://mint.example.com', operationId: 'op-1' },
  } as const;
  expect(resourceEventSchema.parse(event)).toEqual(event);
  for (const invalid of [
    { ...event, token: 'bearer' },
    { ...event, timestamp: 'not-a-date' },
    { ...event, type: 'unknown' },
    { ...event, data: { ...event.data, secret: 'secret' } },
    { ...event, data: { ...event.data, operationId: '' } },
    { ...event, data: { ...event.data, mintUrl: 'file:///mint' } },
  ])
    expect(() => resourceEventSchema.parse(invalid)).toThrow();
});
