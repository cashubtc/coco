import { expect, test } from 'bun:test';
import type { Manager } from '@cashu/coco-core';

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
