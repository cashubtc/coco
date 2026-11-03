import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager.ts';
import type { WebSocketLike } from '../../infra/WsConnectionManager.ts';
import type { TransportEvent } from '../../infra/RealTimeTransport.ts';
import type { WsRequest } from '../../infra/SubscriptionProtocol.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const mintUrl = 'https://repair.test';
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

class ControlledSocket implements WebSocketLike {
  readonly requests: WsRequest[] = [];
  readonly listeners = new Map<TransportEvent, Array<(event: any) => void>>();
  closed = false;
  send(data: string): void {
    this.requests.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.emit('close');
  }
  addEventListener(type: TransportEvent, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(): void {}
  // Deliberately allow events after close, as an OS/network callback already queued may arrive late.
  emit(type: TransportEvent, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  notify(subId: string, state = 'SPENT'): void {
    this.emit('message', {
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { subId, payload: { Y: 'proof', state } },
      }),
    });
  }
}

// Public Session/subscription APIs with real services, repositories and transports. Silent socket
// death, late OS callbacks, offline requests and timer races need controlled external boundaries.
describe('Manager.ensureSubscriptions networking repair', () => {
  let coco: Manager;
  let sockets: ControlledSocket[];
  let requests: string[][];
  let failSockets: boolean;
  let respond: () => Promise<void>;
  let now: number;
  type Timer = ReturnType<typeof setTimeout>;
  let timers: Map<Timer, { callback: () => void; delay: number }>;
  let restore: () => void;

  beforeEach(() => {
    sockets = [];
    requests = [];
    failSockets = false;
    respond = async () => {};
    now = 1000;
    timers = new Map();
    let nextId = 0;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay = 0,
    ) => {
      const id = ++nextId as unknown as Timer;
      timers.set(id, { callback, delay });
      return id;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
      timers.delete(id as Timer);
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.pathname.startsWith('/v1/melt/quote/bolt11/')) {
        const quote = url.pathname.split('/').at(-1)!;
        requests.push([quote]);
        await respond();
        return Response.json({
          quote,
          amount: 1,
          unit: 'sat',
          fee_reserve: 0,
          request: 'invoice',
          expiry: 9999999999,
          state: 'PENDING',
          payment_preimage: null,
        });
      }
      const { Ys } = JSON.parse(String(init.body)) as { Ys: string[] };
      requests.push(Ys);
      await respond();
      return Response.json({ states: Ys.map((Y) => ({ Y, state: 'UNSPENT' })) });
    }) as typeof fetch;
    restore = () => {
      clock.mockRestore();
      timeout.mockRestore();
      clear.mockRestore();
      globalThis.fetch = originalFetch;
    };
  });

  afterEach(async () => {
    await coco?.dispose();
    restore();
  });

  async function start(mode: 'hybrid' | 'polling' = 'hybrid') {
    const ws = globalThis.WebSocket;
    if (mode === 'polling') globalThis.WebSocket = undefined as unknown as typeof WebSocket;
    try {
      coco = await initializeCoco({
        repo: new MemoryRepositories(),
        seedGetter: async () => new Uint8Array(64).fill(1),
        watchers: {
          mintOperationWatcher: { disabled: true },
          meltQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
          meltSettlementProcessor: { disabled: true },
          mintSwapOperationProcessor: { disabled: true },
        },
        requestRateLimit: { disabled: true },
        subscriptions: { fastPollingIntervalMs: 20, slowPollingIntervalMs: 100 },
        ...(mode === 'hybrid'
          ? {
              webSocketFactory: () => {
                if (failSockets) throw new Error('offline');
                const socket = new ControlledSocket();
                sockets.push(socket);
                return socket;
              },
            }
          : {}),
      });
    } finally {
      globalThis.WebSocket = ws;
    }
  }

  function fire(at: number) {
    expect(timers.size).toBe(1);
    now = at;
    const [id, timer] = [...timers][0]!;
    timers.delete(id);
    timer.callback();
  }

  it('replaces a silently dead socket, retains callbacks and fences every old event', async () => {
    await start();
    const received: unknown[] = [];
    let failed = false;
    const subscription = await coco.subscriptions.subscribe<{ state: string }>(
      mintUrl,
      'proof_state',
      ['proof'],
      (p) => {
        received.push(p);
        if (p.state === 'SPENT' && !failed) {
          failed = true;
          throw new Error('downstream handling failed');
        }
      },
    );
    const old = sockets[0]!;
    old.emit('open');
    await settle();
    old.notify(subscription.subId);
    received.length = 0;

    const first = coco.ensureSubscriptions();
    expect(coco.ensureSubscriptions()).toBe(first);
    await first;
    expect(sockets).toHaveLength(2);
    expect(old.closed).toBe(true);
    const replacement = sockets[1]!;
    replacement.emit('open');
    old.emit('open');
    old.emit('error');
    old.emit('close');
    old.notify(subscription.subId, 'PENDING');
    expect(received).toEqual([]);
    expect(replacement.requests.filter((r) => r.method === 'subscribe')).toEqual([
      expect.objectContaining({
        params: { kind: 'proof_state', filters: ['proof'], subId: subscription.subId },
      }),
    ]);
    // Identical evidence can be delivered after repair, even if previous handling failed.
    replacement.notify(subscription.subId);
    expect(received).toEqual([{ Y: 'proof', state: 'SPENT' }]);
    await subscription.unsubscribe();
    expect(replacement.requests.at(-1)?.method).toBe('unsubscribe');
    expect(sockets).toHaveLength(2);
  });

  it('replays only current interests when subscriptions change before replacement opens', async () => {
    await start();
    const removed = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['removed']);
    const kept = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['kept']);
    // The original connection never even opened.
    const repair = coco.ensureSubscriptions();
    await removed.unsubscribe();
    const added = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['added']);
    await repair;
    const replacement = sockets[1]!;
    replacement.emit('open');
    expect(replacement.requests.map((r) => r.params.subId).sort()).toEqual(
      [kept.subId, added.subId].sort(),
    );
    await kept.unsubscribe();
    await coco.ensureSubscriptions();
    sockets[2]!.emit('open');
    expect(sockets[2]!.requests.map((r) => r.params.subId)).toEqual([added.subId]);
  });

  it.each(['hybrid', 'polling'] as const)(
    'preserves cadence and one in-flight poll during %s repair',
    async (mode) => {
      await start(mode);
      let finish!: () => void;
      respond = () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        });
      const received: unknown[] = [];
      await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['first'], (p) => {
        received.push(p);
      });
      await settle();
      expect(requests).toEqual([['first']]);
      now = 1050;
      await Promise.all([coco.ensureSubscriptions(), coco.ensureSubscriptions()]);
      await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['second']);
      await settle();
      expect(requests).toHaveLength(1);
      expect(timers.size).toBe(0);
      respond = async () => {};
      finish();
      await settle();
      expect(received).toEqual([expect.objectContaining({ Y: 'first', state: 'UNSPENT' })]);
      expect([...timers.values()].map((t) => t.delay)).toEqual([20]);
      const stale = [...timers.values()][0]!.callback;
      now = 1060;
      await coco.ensureSubscriptions();
      stale();
      await settle();
      expect(requests).toHaveLength(1);
      expect([...timers.values()].map((t) => t.delay)).toEqual([10]);
      fire(1070);
      await settle();
      expect(requests).toEqual([['first'], ['first', 'second']]);
      expect(timers.size).toBe(1);
      // An overdue timer gets replaced by one immediate opportunity, never two.
      now = 1100;
      await Promise.all([coco.ensureSubscriptions(), coco.ensureSubscriptions()]);
      await settle();
      expect(requests).toHaveLength(3);
      expect(timers.size).toBe(1);
    },
  );

  it.each(['hybrid', 'polling'] as const)(
    'retains failed proof polling across offline %s repair',
    async (mode) => {
      await start(mode);
      respond = async () => {
        throw new TypeError('offline');
      };
      const received: unknown[] = [];
      await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['proof'], (p) => {
        received.push(p);
      });
      await settle();
      expect(requests).toEqual([['proof']]);

      await Promise.all([coco.ensureSubscriptions(), coco.ensureSubscriptions()]);
      expect(requests).toHaveLength(1);
      expect([...timers.values()].map((t) => t.delay)).toEqual([20]);
      // Retain the opportunity even if another attempt fails before connectivity returns.
      fire(1020);
      await settle();
      expect(requests).toHaveLength(2);
      expect(received).toEqual([]);

      respond = async () => {};
      now = 1030;
      await coco.ensureSubscriptions();
      if (mode === 'hybrid') sockets.at(-1)!.emit('open');
      expect(requests).toHaveLength(2);
      expect([...timers.values()].map((t) => t.delay)).toEqual([10]);
      fire(1040);
      await settle();
      expect(requests).toEqual([['proof'], ['proof'], ['proof']]);
      expect(received).toEqual([expect.objectContaining({ Y: 'proof', state: 'UNSPENT' })]);
      expect([...timers.values()].map((t) => t.delay)).toEqual([mode === 'hybrid' ? 100 : 20]);
    },
  );

  it.each([
    ['hybrid', false],
    ['polling', false],
    ['hybrid', true],
    ['polling', true],
  ] as const)(
    'does not duplicate proof opportunities when interests change during %s repair (poll fails=%s)',
    async (mode, fails) => {
      await start(mode);
      let finish!: () => void;
      respond = () =>
        new Promise<void>((resolve, reject) => {
          finish = () => (fails ? reject(new TypeError('offline')) : resolve());
        });
      const removedPayloads: unknown[] = [];
      const removed = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['old'], (p) => {
        removedPayloads.push(p);
      });
      await settle();
      await coco.ensureSubscriptions();
      await removed.unsubscribe();
      await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['new']);
      await coco.subscriptions.subscribe(mintUrl, 'bolt11_melt_quote', ['quote']);
      respond = async () => {};
      finish();
      await settle();
      for (const at of [1020, 1040, 1060, 1080]) {
        fire(at);
        await settle();
      }
      expect(requests).toEqual([['old'], ['new'], ['quote'], ['new'], ['quote']]);
      expect(removedPayloads).toEqual([]);
      expect(timers.size).toBe(1);
    },
  );

  it.each(['unsubscribe', 'dispose'] as const)(
    'does not restart a failed in-flight proof poll after %s',
    async (stop) => {
      await start('polling');
      let fail!: () => void;
      respond = () =>
        new Promise<void>((_resolve, reject) => {
          fail = () => reject(new TypeError('offline'));
        });
      const subscription = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['proof']);
      await settle();
      if (stop === 'dispose') await coco.dispose();
      else await subscription.unsubscribe();
      fail();
      await settle();
      now = 1100;
      await coco.ensureSubscriptions();
      await settle();
      expect(requests).toEqual([['proof']]);
      expect(timers.size).toBe(0);
    },
  );

  it('keeps quote polling fair across repeated WebSocket replays', async () => {
    await start();
    await coco.subscriptions.subscribe(mintUrl, 'bolt11_melt_quote', ['a']);
    await coco.subscriptions.subscribe(mintUrl, 'bolt11_melt_quote', ['b']);
    sockets[0]!.emit('open');
    await settle();
    expect(requests).toEqual([['a']]);
    for (let i = 0; i < 3; i++) {
      await coco.ensureSubscriptions();
      sockets.at(-1)!.emit('open');
    }
    for (const at of [1100, 1200, 1300, 1400]) {
      fire(at);
      await settle();
    }
    expect(requests).toEqual([['a'], ['b'], ['a'], ['b'], ['a']]);
    expect(timers.size).toBe(1);
    expect([...timers.values()].map((t) => t.delay)).toEqual([100]);
  });

  it('closes one mint on the shared polling transport without disturbing another', async () => {
    await start('polling');
    const removed = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['removed']);
    await coco.subscriptions.subscribe('https://other.test', 'proof_state', ['kept']);
    await settle();
    coco.subscriptions.closeMint(mintUrl);
    await removed.unsubscribe();
    await coco.ensureSubscriptions();
    expect(timers.size).toBe(1);
    fire(1020);
    await settle();
    expect(requests).toEqual([['removed'], ['kept'], ['kept']]);
  });

  it('does not replay a repair queued before subscriptions are closed', async () => {
    await start();
    await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['removed']);
    const repair = coco.subscriptions.ensureSubscriptions();
    coco.subscriptions.closeAll();
    await repair;
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
    await settle();
    expect(timers.size).toBe(0);
  });

  it('retains a shared registration when its first callback unsubscribes during repair', async () => {
    await start();
    const firstPayloads: unknown[] = [];
    const secondPayloads: unknown[] = [];
    const first = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['shared'], (p) => {
      firstPayloads.push(p);
    });
    const second = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['shared'], (p) => {
      secondPayloads.push(p);
    });
    expect(second.subId).toBe(first.subId);
    await settle();
    firstPayloads.length = 0;
    secondPayloads.length = 0;
    const repair = coco.ensureSubscriptions();
    await first.unsubscribe();
    await repair;
    sockets[1]!.emit('open');
    sockets[1]!.notify(second.subId);
    expect(firstPayloads).toEqual([]);
    expect(secondPayloads).toHaveLength(1);
    expect(sockets[1]!.requests.map((r) => r.method)).toEqual(['subscribe']);
    await second.unsubscribe();
    expect(sockets[1]!.requests.map((r) => r.method)).toEqual(['subscribe', 'unsubscribe']);
  });

  it('returns offline without waiting for socket open or outstanding HTTP', async () => {
    await start();
    let finish!: () => void;
    respond = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['proof']);
    await settle();
    failSockets = true;
    await coco.ensureSubscriptions();
    expect(sockets[0]!.closed).toBe(true);
    expect(requests).toHaveLength(1);
    failSockets = false;
    await coco.ensureSubscriptions();
    expect(sockets).toHaveLength(2);
    finish();
    await settle();
  });

  it.each([false, true])(
    'cannot resurrect networking across disposal (repair initiated=%s)',
    async (initiated) => {
      await start();
      const subscription = await coco.subscriptions.subscribe(mintUrl, 'proof_state', ['proof']);
      await settle();
      const staleTimer = [...timers.values()][0]!.callback;
      const repairing = coco.ensureSubscriptions();
      if (initiated) await repairing;
      await Promise.all([repairing, coco.dispose()]);
      const count = sockets.length;
      await coco.ensureSubscriptions();
      await coco.subscriptions.ensureSubscriptions();
      await subscription.unsubscribe();
      for (const socket of sockets) {
        socket.emit('open');
        socket.emit('close');
        socket.notify(subscription.subId);
      }
      staleTimer();
      await settle();
      expect(sockets).toHaveLength(count);
      expect(sockets.every((s) => s.closed)).toBe(true);
      expect(timers.size).toBe(0);
      expect(requests).toHaveLength(1);
    },
  );
});
