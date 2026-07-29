import { describe, expect, test } from 'bun:test';
import { toAmount, type Manager } from '@cashu/coco-core';

import { createRouteHandlers } from './routes';
import { DaemonStateManager } from './utils/state';

function unlockedStateManager(manager?: unknown): DaemonStateManager {
  const stateManager = new DaemonStateManager();
  const fakeManager = (manager ?? {}) as Manager;
  const fakeNpcAccount = {} as unknown as import('coco-cashu-plugin-npc').NPCAccountApi;
  stateManager.setUnlocked(
    fakeManager,
    'https://mint.example.com',
    new Uint8Array([1, 2, 3]),
    fakeNpcAccount,
  );
  return stateManager;
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('routes', () => {
  test('/init validates invalid mnemonic', async () => {
    const stateManager = new DaemonStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/init']!.POST!(
      postJson('/init', { mnemonic: 'invalid mnemonic' }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mnemonic');
  });

  test('/unlock requires passphrase', async () => {
    const stateManager = new DaemonStateManager();
    stateManager.setLocked('encrypted', 'https://mint.example.com');
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/unlock']!.POST!(
      postJson('/unlock', {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Passphrase required');
  });

  test('/x-cashu/parse requires request field', async () => {
    const stateManager = unlockedStateManager();
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/x-cashu/parse']!.POST!(
      postJson('/x-cashu/parse', {}),
      stateManager.getState(),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Request is required');
  });

  test('/balance reports numeric per-mint totals from the v2 balance snapshots', async () => {
    const manager = {
      wallet: {
        balances: {
          byMint: async () => ({
            'https://mint.example.com': {
              spendable: toAmount(40),
              reserved: toAmount(2),
              total: toAmount(42),
              unit: 'sat',
            },
          }),
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/balance']!.GET!(
      new Request('http://localhost/balance'),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output?: Record<string, { sats: number }> };
    expect(response.status).toBe(200);
    expect(body.output).toEqual({ 'https://mint.example.com': { sats: 42 } });
  });

  test('/receive/cashu reports the received amount as a number', async () => {
    let executed = false;
    const manager = {
      ops: {
        receive: {
          prepare: async () => ({ amount: toAmount(5) }),
          execute: async () => {
            executed = true;
          },
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/receive/cashu']!.POST!(
      postJson('/receive/cashu', { token: 'cashuB-fake' }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output?: string };
    expect(body.output).toBe('Received 5');
    expect(executed).toBe(true);
  });

  test('/receive/bolt11 creates a canonical quote and prepares the mint operation with it', async () => {
    const createdQuote = { quoteId: 'q1', request: 'lnbc210n1fake' };
    let createInput: unknown;
    let prepareInput: unknown;
    const manager = {
      quotes: {
        mint: {
          create: async (input: unknown) => {
            createInput = input;
            return createdQuote;
          },
        },
      },
      ops: {
        mint: {
          prepare: async (input: unknown) => {
            prepareInput = input;
            return {};
          },
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/receive/bolt11']!.POST!(
      postJson('/receive/bolt11', { amount: 21 }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toBe('lnbc210n1fake');
    expect(createInput).toEqual({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      amount: 21,
    });
    expect(prepareInput).toEqual({ quote: createdQuote, amount: 21 });
  });

  test('/send/bolt11 creates a canonical melt quote and executes the prepared melt', async () => {
    const createdQuote = { quoteId: 'q2' };
    let createInput: unknown;
    let prepareInput: unknown;
    let executed = false;
    const manager = {
      quotes: {
        melt: {
          create: async (input: unknown) => {
            createInput = input;
            return createdQuote;
          },
        },
      },
      ops: {
        melt: {
          prepare: async (input: unknown) => {
            prepareInput = input;
            return { id: 'op1' };
          },
          execute: async () => {
            executed = true;
          },
        },
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/send/bolt11']!.POST!(
      postJson('/send/bolt11', { invoice: 'lnbc210n1fake' }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toBe('Paid invoice: lnbc210n1fake');
    expect(createInput).toEqual({
      mintUrl: 'https://mint.example.com',
      method: 'bolt11',
      methodData: { invoice: 'lnbc210n1fake' },
    });
    expect(prepareInput).toEqual({ quote: createdQuote });
    expect(executed).toBe(true);
  });

  test('/x-cashu/handle settles an inband request into an X-Cashu header', async () => {
    const token = {
      mint: 'https://mint.example.com',
      unit: 'sat',
      proofs: [
        {
          id: '009a1f293253e41e',
          amount: 21,
          secret: 'test-secret',
          C: '02a9acc1e48c25eeeb9289b5031cc57da9fe72f3fe2861d264bdc074209b107ba2',
        },
      ],
    };
    const manager = {
      paymentRequests: {
        parse: async () => ({
          payableMints: ['https://mint.example.com'],
          allowedMints: [],
          transport: { type: 'inband' },
        }),
        prepare: async () => ({ id: 'prepared' }),
        execute: async () => ({ type: 'inband', token }),
      },
    };
    const stateManager = unlockedStateManager(manager);
    const routes = createRouteHandlers(stateManager);

    const response = await routes['/x-cashu/handle']!.POST!(
      postJson('/x-cashu/handle', { request: 'creqA-fake' }),
      stateManager.getState(),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toStartWith('X-Cashu: cashu');
  });
});
