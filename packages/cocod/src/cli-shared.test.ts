import { afterEach, describe, expect, mock, test } from 'bun:test';

import { ensureDaemonRunning } from './cli-shared';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('ensureDaemonRunning', () => {
  test('waits for an already-running daemon to finish startup', async () => {
    const requestedPaths: string[] = [];
    let statusRequests = 0;
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedPaths.push(url.pathname);

      if (url.pathname === '/ping') {
        return Response.json({ output: 'pong' });
      }

      statusRequests += 1;
      return Response.json({ output: statusRequests === 1 ? 'STARTING' : 'UNLOCKED' });
    }) as unknown as typeof fetch;

    await ensureDaemonRunning();

    expect(statusRequests).toBe(2);
    expect(requestedPaths).toEqual(['/ping', '/status', '/status']);
  });
});
