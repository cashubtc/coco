import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initializeCoco, toAmount, type Manager } from '@cashu/coco-core';
import { SqliteRepositories } from '@cashu/coco-sqlite-bun';

import { createRouteHandlers } from './routes';
import {
  CocodRuntimeError,
  type CocodRuntime,
  type CocodStatus,
  type RunningCocoSession,
} from './runtime';

// A creqB (TLV + bech32m) payment request for 21 sat carrying a P2PK NUT-10
// spending condition, generated once with the workspace @cashu/cashu-ts.
const CREQB_P2PK_FIXTURE =
  'CREQB1QYQQ2UN9WYKNZQSQPQQQQQQQQQQQQ9GRQQQSQPQQQYQQ2QQCDP68GURN8GHJ7MTFDE6ZUETCV9KHQMR99E3K7MGXQQX8GETNWSS8QCTED4JKUAQ8QQ0QZQQPQYPQQ9MGW368QUE69UHK27RPD4CXCEFWVDHK6TMSV9USSQZFQYQQZQQZQPPRQVNP89SKXCE3V56RSCEJX4JK2ETZ8YERSWTZX5CRXVTRVV6NWERP89NX2DEJVCEKVEFJ8QMRZEPJXC6XYERRXQMNGV3S893RZVPHVFSNYU24ZDV';

function fakeRuntime(
  status: CocodStatus,
  session: RunningCocoSession | null = null,
  overrides: Partial<CocodRuntime> = {},
): CocodRuntime {
  return {
    getStatus: () => status,
    getRunningSession: () => session,
    ...overrides,
  } as unknown as CocodRuntime;
}

function uninitializedRuntime(overrides: Partial<CocodRuntime> = {}): CocodRuntime {
  return fakeRuntime(
    {
      wallet: null,
      seedAccess: null,
      cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
    },
    null,
    overrides,
  );
}

function lockedRuntime(): CocodRuntime {
  return fakeRuntime({
    wallet: {
      configuredAt: '2026-08-16T00:00:00.000Z',
      mintUrl: 'https://mint.example.com',
    },
    seedAccess: { state: 'locked', requiresPassphrase: true },
    cocoSession: { state: 'stopped', startedAt: null, lastFailure: null },
  });
}

function runningRuntime(manager?: unknown): CocodRuntime {
  const fakeManager = (manager ?? {}) as Manager;
  const fakeNpcAccount = {} as unknown as import('coco-cashu-plugin-npc').NPCAccountApi;
  return fakeRuntime(
    {
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'available', requiresPassphrase: false },
      cocoSession: {
        state: 'running',
        startedAt: '2026-08-16T00:00:01.000Z',
        lastFailure: null,
      },
    },
    {
      manager: fakeManager,
      mintUrl: 'https://mint.example.com',
      npcAccount: fakeNpcAccount,
    },
  );
}

function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('routes', () => {
  test('/init validates invalid mnemonic', async () => {
    const runtime = uninitializedRuntime({
      initializeWallet: async () => {
        throw new CocodRuntimeError('invalid_mnemonic', 'Invalid mnemonic');
      },
    });
    const routes = createRouteHandlers(runtime);

    const response = await routes['/init']!.POST!(
      postJson('/init', { mnemonic: 'invalid mnemonic' }),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mnemonic');
  });

  test('/init validates invalid mint URL', async () => {
    const runtime = uninitializedRuntime({
      initializeWallet: async () => {
        throw new CocodRuntimeError('invalid_mint_url', 'Invalid mint URL');
      },
    });
    const routes = createRouteHandlers(runtime);

    const response = await routes['/init']!.POST!(postJson('/init', { mintUrl: 'not a URL' }));

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Invalid mint URL');
  });

  test('/init maps concurrent Wallet initialization to a conflict', async () => {
    const runtime = uninitializedRuntime({
      initializeWallet: async () => {
        throw new CocodRuntimeError('wallet_already_configured', 'Wallet already initialized');
      },
    });
    const routes = createRouteHandlers(runtime);

    const response = await routes['/init']!.POST!(postJson('/init', {}));

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(409);
    expect(body.error).toBe('Wallet already initialized');
  });

  test('/status reports a quarantined encrypted Session as an error', async () => {
    const runtime = fakeRuntime({
      wallet: {
        configuredAt: '2026-08-16T00:00:00.000Z',
        mintUrl: 'https://mint.example.com',
      },
      seedAccess: { state: 'locked', requiresPassphrase: true },
      cocoSession: {
        state: 'failed',
        startedAt: null,
        lastFailure: {
          code: 'session_start_failed',
          message: 'Coco Session failed to start',
          occurredAt: '2026-08-16T00:00:01.000Z',
        },
      },
    });
    const routes = createRouteHandlers(runtime);

    const response = await routes['/status']!.GET!(new Request('http://localhost/status'));

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toBe('ERROR');
  });

  test('/unlock requires passphrase', async () => {
    const runtime = lockedRuntime();
    const routes = createRouteHandlers(runtime);

    const response = await routes['/unlock']!.POST!(postJson('/unlock', {}));

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Passphrase required');
  });

  test('/x-cashu/parse requires request field', async () => {
    const runtime = runningRuntime();
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/parse']!.POST!(postJson('/x-cashu/parse', {}));

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toBe('Request is required');
  });

  test('/x-cashu/parse accepts a creqB request and keeps its P2PK lock intact', async () => {
    // Real core against an in-memory database: proves the workspace decoder does not
    // discard the NUT-10 condition and that core classifies it as an enforceable P2PK
    // lock. This test gates the removal of cocod's former creqB/NUT-10 rejections.
    const repo = new SqliteRepositories({ database: new Database(':memory:') });
    const manager = await initializeCoco({
      repo,
      seedGetter: async () => new Uint8Array(64).fill(7),
    });
    try {
      const parsed = await manager.paymentRequests.parse(CREQB_P2PK_FIXTURE);
      expect(parsed.spendingCondition?.kind).toBe('P2PK');
      expect(parsed.amount?.toNumber()).toBe(21);

      const runtime = runningRuntime(manager);
      const routes = createRouteHandlers(runtime);
      const response = await routes['/x-cashu/parse']!.POST!(
        postJson('/x-cashu/parse', { request: CREQB_P2PK_FIXTURE }),
      );
      const body = (await response.json()) as { output?: string };
      expect(response.status).toBe(200);
      expect(body.output).toContain('21 Sats');
    } finally {
      await manager.dispose();
    }
  });

  test('/x-cashu/handle rejects unsupported spending conditions before preparing proofs', async () => {
    let prepareCalled = false;
    const manager = {
      paymentRequests: {
        parse: async () => ({
          payableMints: ['https://mint.example.com'],
          allowedMints: [],
          transport: { type: 'inband' },
          spendingCondition: { kind: 'unsupported', nut10Kind: 'HTLC' },
        }),
        prepare: async () => {
          prepareCalled = true;
          throw new Error('should not prepare');
        },
      },
    };
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/handle']!.POST!(
      postJson('/x-cashu/handle', { request: 'creqA-fake' }),
    );

    const body = (await response.json()) as { error?: string };
    expect(response.status).toBe(400);
    expect(body.error).toContain('NUT-10');
    expect(body.error).toContain('HTLC');
    expect(prepareCalled).toBe(false);
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
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/balance']!.GET!(new Request('http://localhost/balance'));

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
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/receive/cashu']!.POST!(
      postJson('/receive/cashu', { token: 'cashuB-fake' }),
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
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/receive/bolt11']!.POST!(
      postJson('/receive/bolt11', { amount: 21 }),
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
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/send/bolt11']!.POST!(
      postJson('/send/bolt11', { invoice: 'lnbc210n1fake' }),
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
    const runtime = runningRuntime(manager);
    const routes = createRouteHandlers(runtime);

    const response = await routes['/x-cashu/handle']!.POST!(
      postJson('/x-cashu/handle', { request: 'creqA-fake' }),
    );

    const body = (await response.json()) as { output?: string };
    expect(response.status).toBe(200);
    expect(body.output).toStartWith('X-Cashu: cashu');
  });
});
