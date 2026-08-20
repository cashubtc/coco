import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCocoLifecycleAdapter, type RunningCocoLifecycleAdapter } from './adapter.ts';

const CONTROL_TOKEN = 'coco-fault-lab-test-token';
const MINT_URL = 'http://127.0.0.1:4300';

describe('Coco Fault Lab lifecycle HTTP adapter', () => {
  let adapter: RunningCocoLifecycleAdapter | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    await adapter?.stop();
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('exposes an authenticated, resettable mint lifecycle wallet', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'coco-fault-lab-'));
    adapter = await startCocoLifecycleAdapter({
      controlToken: CONTROL_TOKEN,
      databasePath: join(temporaryDirectory, 'coco.sqlite'),
      host: '127.0.0.1',
      mintId: 'mintd-local',
      mintUrl: MINT_URL,
      port: 0,
      unit: 'sat',
    });

    const capabilities = await request(adapter.url, '/v1/lifecycle/capabilities');
    expect(capabilities).toMatchObject({
      schemaVersion: 1,
      implementation: { id: 'coco', language: 'typescript' },
      operations: ['mint'],
      durability: 'process',
      recovery: ['quote_state', 'nut09_restore'],
      mints: [{ id: 'mintd-local', implementation: 'mintd' }],
    });

    expect(
      await request(adapter.url, '/v1/lifecycle/reset', {
        method: 'POST',
        body: JSON.stringify({ seed: 'wallet-lifecycle-v1:mint-response-lost' }),
      }),
    ).toEqual({ ok: true });

    expect(await request(adapter.url, '/v1/lifecycle/wallet')).toEqual({
      walletId: 'coco',
      mint: MINT_URL,
      unit: 'sat',
      balances: { available: 0, reserved: 0, recoverable: 0 },
      proofs: [],
    });
  });

  it('rejects lifecycle requests without the control token', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'coco-fault-lab-'));
    adapter = await startCocoLifecycleAdapter({
      controlToken: CONTROL_TOKEN,
      databasePath: join(temporaryDirectory, 'coco.sqlite'),
      host: '127.0.0.1',
      mintId: 'mintd-local',
      mintUrl: MINT_URL,
      port: 0,
      unit: 'sat',
    });

    const response = await fetch(`${adapter.url}/v1/lifecycle/capabilities`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: 'UNAUTHORIZED',
      message: 'A valid adapter control token is required',
    });
  });
});

async function request(origin: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${CONTROL_TOKEN}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${origin}${path}`, { ...init, headers });
  expect(response.status).toBe(200);
  return response.json();
}
