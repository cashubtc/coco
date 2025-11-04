import { describe, it, beforeEach, afterEach, expect } from 'bun:test';
import { RequestRateLimiter } from '../../infra/RequestRateLimiter.ts';
import { HttpResponseError, NetworkError, MintOperationError } from '../../models/Error.ts';
import type { HeadersInit } from 'bun';

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

describe('RequestRateLimiter', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Ensure clean fetch per test
    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    // @ts-ignore
    globalThis.fetch = originalFetch;
  });

  it('passes JSON body and headers, returns parsed JSON', async () => {
    const calls: Array<{ input: any; init?: any }> = [];
    // @ts-ignore
    globalThis.fetch = async (input: any, init?: RequestInit) => {
      calls.push({ input, init });
      const body = { ok: true, received: true };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const limiter = new RequestRateLimiter({ capacity: 25, refillPerMinute: 25 });

    const res = await limiter.request<{ ok: boolean; received: boolean }>({
      endpoint: 'https://mint.test/v1/swap',
      method: 'POST',
      headers: { 'X-Custom': 'ok' },
      requestBody: { a: 1 },
    });

    expect(res.ok).toBe(true);
    expect(res.received).toBe(true);

    expect(calls.length).toBe(1);
    const { input, init } = calls[0]!;
    expect(String(input)).toBe('https://mint.test/v1/swap');
    expect(init?.method).toBe('POST');
    // Body should be stringified JSON
    expect(typeof init?.body).toBe('string');
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));

    // Headers include default Accept, custom, and content-type
    const hdrs = new Headers(init?.headers as HeadersInit);
    expect(hdrs.get('Accept')).toBe('application/json, text/plain, */*');
    expect(hdrs.get('X-Custom')).toBe('ok');
    expect(hdrs.get('Content-Type')).toBe('application/json');
  });

  it('throws HttpResponseError with status and message on non-OK responses', async () => {
    // @ts-ignore
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        statusText: 'Too Many Requests',
      });
    };

    const limiter = new RequestRateLimiter();
    try {
      await limiter.request({ endpoint: 'https://mint.test/v1/keys', method: 'GET' });
      throw new Error('Expected HttpResponseError');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpResponseError);
      const e = err as HttpResponseError;
      expect(e.status).toBe(429);
      expect(e.message).toBe('rate limited');
    }
  });

  it('throws MintOperationError for 400 with protocol error shape', async () => {
    // @ts-ignore
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ code: 4200, detail: 'proof already spent' }), {
        status: 400,
        statusText: 'Bad Request',
      });
    };

    const limiter = new RequestRateLimiter();
    try {
      await limiter.request({ endpoint: 'https://mint.test/v1/melt', method: 'POST' });
      throw new Error('Expected MintOperationError');
    } catch (err) {
      expect(err).toBeInstanceOf(MintOperationError);
      const e = err as MintOperationError;
      expect(e.status).toBe(400);
      expect(e.code).toBe(4200);
      expect(e.message).toBe('proof already spent');
    }
  });

  it('throws NetworkError when fetch rejects due to network failure', async () => {
    // @ts-ignore
    globalThis.fetch = async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    };

    const limiter = new RequestRateLimiter();
    try {
      await limiter.request({ endpoint: 'https://mint.test/v1/info', method: 'GET' });
      throw new Error('Expected NetworkError');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const e = err as NetworkError;
      expect(e.message).toBe('getaddrinfo ENOTFOUND');
    }
  });

  it('queues requests FIFO when tokens are exhausted', async () => {
    const order: number[] = [];
    // @ts-ignore
    globalThis.fetch = async (input: any) => {
      const u = new URL(String(input));
      const id = Number(u.searchParams.get('id') || '0');
      order.push(id);
      return new Response(JSON.stringify({ id }), { status: 200 });
    };

    // capacity 1, refill ~1 token per second to make queuing observable
    const limiter = new RequestRateLimiter({ capacity: 1, refillPerMinute: 60 });

    const p1 = limiter.request<{ id: number }>({
      endpoint: 'https://mint.test/v1/test?id=1',
      method: 'GET',
    });
    const p2 = limiter.request<{ id: number }>({
      endpoint: 'https://mint.test/v1/test?id=2',
      method: 'GET',
    });
    const p3 = limiter.request<{ id: number }>({
      endpoint: 'https://mint.test/v1/test?id=3',
      method: 'GET',
    });

    // Immediately after scheduling, only first should have fired
    await sleep(100);
    expect(order.length).toBe(1);

    const r1 = await p1;
    expect(r1.id).toBe(1);

    // Wait for the remaining two to complete (up to ~2.5s)
    const r = await Promise.all([p2, p3]);
    expect(r.map((x) => x.id)).toEqual([2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('bypasses throttling for configured path prefixes (startsWith on pathname)', async () => {
    const calls: Array<{ path: string; id?: number; t: number }> = [];

    const deferred = () => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    };

    const gate = deferred();

    // @ts-ignore
    globalThis.fetch = async (input: any) => {
      const u = new URL(String(input));
      const idParam = u.searchParams.get('id');
      const id = idParam ? Number(idParam) : undefined;
      calls.push({ path: `${u.pathname}${id ? `?id=${id}` : ''}`, id, t: Date.now() });

      // Hold the first non-bypass call to ensure tokens are exhausted and queue builds up
      if (u.pathname === '/v1/test' && id === 1) {
        await gate.promise;
      }

      return new Response(JSON.stringify({ ok: true, id }), { status: 200 });
    };

    const limiter = new RequestRateLimiter({
      capacity: 1,
      refillPerMinute: 60, // ~1 per second
      bypassPathPrefixes: ['/v1/info'],
    });

    // Consume the only token with a non-bypass request and keep it in-flight
    const pA = limiter.request({ endpoint: 'https://mint.test/v1/test?id=1', method: 'GET' });

    // Queue another non-bypass request which must wait for refill
    const pB = limiter.request({ endpoint: 'https://mint.test/v1/test?id=2', method: 'GET' });

    // Immediately schedule two bypassed requests
    const t0 = Date.now();
    const i1 = limiter.request({ endpoint: 'https://mint.test/v1/info', method: 'GET' });
    const i2 = limiter.request({ endpoint: 'https://mint.test/v1/info/stats', method: 'GET' });

    // Bypass calls should complete quickly even while a non-bypass is queued
    const [r1, r2] = await Promise.all([i1, i2]);
    const dtBypass = Date.now() - t0;
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(dtBypass).toBeLessThan(500);

    // Ensure queued non-bypass did not fire yet
    const hasB = calls.some((c) => c.path === '/v1/test?id=2');
    expect(hasB).toBe(false);

    // Release the first call, then wait for refill to allow the queued one to proceed
    gate.resolve();
    await pA;
    await sleep(1200);

    const hasBAfter = calls.some((c) => c.path === '/v1/test?id=2');
    expect(hasBAfter).toBe(true);

    // Sanity: ensure both bypass endpoints were called
    expect(calls.some((c) => c.path === '/v1/info')).toBe(true);
    expect(calls.some((c) => c.path === '/v1/info/stats')).toBe(true);
  });
});
