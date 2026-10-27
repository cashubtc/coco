import { Amount, deriveKeysetId, OutputData } from '@cashu/cashu-ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SqlStorageRepositories } from '../../../sql-storage/src/repositories.ts';
import { SqliteDb } from '../../../sqlite-bun/src/db.ts';
import { initializeCoco, Manager } from '../../Manager.ts';
import { meltQuoteFromBolt11Response } from '../../models/MeltQuote.ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { PendingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { PendingSendOperation } from '../../operations/send/SendOperation.ts';
import type { Repositories } from '../../repositories/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { serializeOutputData } from '../../utils.ts';
import { pendingSend } from '../fixtures/SendOperation.ts';
import { mintQuoteFromBolt11Fixture } from '../normalizedMintQuoteFixtures.ts';

const mintUrl = 'https://background.test';
const keys = { '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' };
const keysetId = deriveKeysetId(keys, { unit: 'sat' });
const seed = new Uint8Array(64).fill(1);
const disabledRuntime = {
  watchers: {
    mintOperationWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
};

// These workflows use the Session facade and real storage, transactions, handlers and events.
// Enabling owners after initializeCoco isolates their discovery from the unchanged recovery sweeps.
describe.each(['memory', 'sqlite'] as const)('background progression (%s)', (adapter) => {
  let repo: Repositories;
  let database: Database | undefined;
  let coco: Manager;
  let events: EventBus<CoreEvents>;
  let originalFetch: typeof fetch;
  let requests: string[];
  let meltState: 'PENDING' | 'PAID' | 'UNPAID';
  let mintState: 'UNPAID' | 'PAID' | 'ISSUED';
  let proofState: 'UNSPENT' | 'SPENT';

  beforeEach(async () => {
    database = adapter === 'sqlite' ? new Database(':memory:') : undefined;
    repo = database
      ? new SqlStorageRepositories({ database: new SqliteDb({ database }) })
      : new MemoryRepositories();
    await repo.init();
    const now = Math.floor(Date.now() / 1000);
    await repo.mintRepository.addNewMint({
      mintUrl,
      name: 'Background test mint',
      trusted: true,
      createdAt: now,
      updatedAt: now,
      mintInfo: {
        name: 'Background test mint',
        version: 'test',
        pubkey: '',
        contact: [],
        nuts: {
          '4': {
            methods: [
              {
                method: 'bolt11',
                method_name: 'bolt11',
                unit: 'sat',
                min_amount: 1,
                max_amount: 100,
              },
            ],
            disabled: false,
          },
          '5': {
            methods: [
              {
                method: 'bolt11',
                method_name: 'bolt11',
                unit: 'sat',
                min_amount: 1,
                max_amount: 100,
              },
            ],
            disabled: false,
          },
          '11': { supported: true },
        },
      },
    });
    await repo.keysetRepository.addKeyset({
      mintUrl,
      id: keysetId,
      unit: 'sat',
      keypairs: keys,
      active: true,
      feePpk: 0,
    });
    requests = [];
    meltState = 'PENDING';
    mintState = 'PAID';
    proofState = 'SPENT';
    const respond = (
      path: string,
      body: {
        outputs?: { id: string; amount: number; B_: string }[];
        Ys?: string[];
      },
    ): unknown => {
      if (path === '/v1/melt/bolt11') return remoteMelt('PENDING');
      if (path.startsWith('/v1/melt/quote/bolt11/')) return remoteMelt(meltState);
      if (path.startsWith('/v1/mint/quote/bolt11/')) return remoteMint(mintState);
      // The amount-1 mint key has private scalar 1, so a blind signature is B_ itself.
      if (path === '/v1/swap')
        return {
          signatures: body.outputs!.map((output) => ({
            id: output.id,
            amount: output.amount,
            C_: output.B_,
          })),
        };
      if (path === '/v1/mint/bolt11') {
        if (mintState === 'ISSUED')
          return new Response(JSON.stringify({ code: 20002, detail: 'already issued' }), {
            status: 400,
          });
        return {
          signatures: body.outputs!.map((output) => ({
            id: output.id,
            amount: output.amount,
            C_: output.B_,
          })),
        };
      }
      if (path === '/v1/restore')
        return {
          outputs: body.outputs,
          signatures: body.outputs!.map((output) => ({
            id: output.id,
            amount: output.amount,
            C_: output.B_,
          })),
        };
      if (path === '/v1/checkstate')
        return { states: body.Ys!.map((Y) => ({ Y, state: proofState })) };
      throw new Error(`Unexpected mint request: ${path}`);
    };
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.origin !== mintUrl) throw new Error(`Unexpected mint: ${url.origin}`);
      requests.push(url.pathname);
      const response = await respond(url.pathname, init?.body ? JSON.parse(String(init.body)) : {});
      return response instanceof Response ? response : Response.json(response);
    }) as typeof fetch;
    coco = await initializeCoco({
      repo,
      seedGetter: async () => seed,
      ...disabledRuntime,
      plugins: [
        {
          name: 'background-test-events',
          required: ['eventBus'],
          onReady: ({ services }) => {
            events = services.eventBus;
          },
        },
      ],
      // Keep the real hybrid/polling transport; the socket deliberately supplies no observations.
      webSocketFactory: () => ({
        send() {},
        close() {},
        removeEventListener() {},
        addEventListener(type, listener) {
          if (type === 'open') queueMicrotask(() => listener({}));
        },
      }),
    });
  });

  afterEach(async () => {
    await coco?.dispose();
    globalThis.fetch = originalFetch;
    database?.close();
  });

  function remoteMelt(state: typeof meltState) {
    return {
      quote: 'melt',
      request: 'invoice',
      amount: 1,
      fee_reserve: 0,
      unit: 'sat',
      expiry: 9_999_999_999,
      state,
      payment_preimage: state === 'PAID' ? 'preimage' : null,
    };
  }

  function remoteMint(state: typeof mintState) {
    return { quote: 'mint', request: 'invoice', amount: 1, unit: 'sat', expiry: null, state };
  }

  async function seedMelt(state: typeof meltState, incomplete = false, proofOwner = 'melt-op') {
    const quote = meltQuoteFromBolt11Response(mintUrl, {
      ...remoteMelt(state),
      amount: Amount.from(1),
      fee_reserve: Amount.zero(),
    });
    if (incomplete) quote.change = undefined;
    await repo.meltQuoteRepository.upsertMeltQuote(quote);
    const operation: PendingMeltOperation = {
      id: 'melt-op',
      state: 'pending',
      mintUrl,
      unit: 'sat',
      method: 'bolt11',
      methodData: { invoice: 'invoice' },
      quoteId: 'melt',
      amount: Amount.from(1),
      fee_reserve: Amount.zero(),
      swap_fee: Amount.zero(),
      needsSwap: false,
      inputAmount: Amount.from(1),
      inputProofSecrets: ['melt-input'],
      changeOutputData: { keep: [], send: [] },
      createdAt: 1,
      updatedAt: 2,
    };
    await repo.meltOperationRepository.create(operation);
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(1),
        C: keys['1'],
        secret: 'melt-input',
        mintUrl,
        unit: 'sat',
        state: 'inflight',
        usedByOperationId: proofOwner,
      },
    ]);
    return operation;
  }

  async function finishMeltChecks() {
    // Initial checks are explicitly deferred past pending-event publication and its operation lock.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await coco.disableMeltSettlementProcessor();
  }

  async function seedMint(state: typeof mintState = 'UNPAID') {
    const quote = mintQuoteFromBolt11Fixture(mintUrl, {
      ...remoteMint(state),
      state,
      amount: Amount.from(1),
    });
    await repo.mintQuoteRepository.upsertMintQuote(quote);
    return coco.ops.mint.prepare({ quote, amount: 1 });
  }

  it.each(['PAID', 'UNPAID'] as const)(
    'advances cached %s Melt evidence with confirmation only for nonpayment',
    async (state) => {
      await seedMelt(state);
      meltState = state;
      await coco.enableMeltSettlementProcessor();
      await finishMeltChecks();
      expect((await coco.ops.melt.get('melt-op'))?.state).toBe(
        state === 'PAID' ? 'finalized' : 'rolled_back',
      );
      expect((await repo.proofRepository.getProofBySecret(mintUrl, 'melt-input'))?.state).toBe(
        state === 'PAID' ? 'spent' : 'ready',
      );
      expect(requests).toEqual(state === 'PAID' ? [] : ['/v1/melt/quote/bolt11/melt']);
    },
  );

  it.each([false, true])(
    'leaves waiting or incomplete Melt evidence pending (incomplete=%s)',
    async (incomplete) => {
      await seedMelt(incomplete ? 'PAID' : 'PENDING', incomplete);
      await coco.enableMeltSettlementProcessor();
      await finishMeltChecks();
      expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
      expect(
        (await repo.proofRepository.getProofBySecret(mintUrl, 'melt-input'))?.usedByOperationId,
      ).toBe('melt-op');
      expect(requests).toEqual([]);
    },
  );

  it('reassesses canonical state instead of advancing from an obsolete event payload', async () => {
    await seedMelt('PENDING');
    await coco.enableMeltSettlementProcessor();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const obsolete = meltQuoteFromBolt11Response(mintUrl, {
      ...remoteMelt('PAID'),
      amount: Amount.from(1),
      fee_reserve: Amount.zero(),
    });
    await events.emit('melt-quote:updated', {
      mintUrl,
      method: 'bolt11',
      quoteId: 'melt',
      quote: obsolete,
    });
    await finishMeltChecks();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
    expect(requests).toEqual([]);
  });

  it('preserves input ownership when cached settlement conflicts with local proofs', async () => {
    await seedMelt('PAID', false, 'other-operation');
    await coco.enableMeltSettlementProcessor();
    await finishMeltChecks();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
    expect(
      (await repo.proofRepository.getProofBySecret(mintUrl, 'melt-input'))?.usedByOperationId,
    ).toBe('other-operation');
    expect(requests).toEqual([]);
  });

  it('requires committed non-payment observation metadata before releasing Melt inputs', async () => {
    await seedMelt('UNPAID');
    const quote = (await coco.quotes.melt.get({ mintUrl, quoteId: 'melt' }))!;
    if (adapter === 'sqlite') {
      database!.run('UPDATE coco_cashu_melt_quotes SET lastObservedRemoteStateAt = NULL');
    } else {
      await repo.meltQuoteRepository.upsertMeltQuote({
        ...quote,
        lastObservedRemoteStateAt: undefined,
      });
    }
    await coco.enableMeltSettlementProcessor();
    await finishMeltChecks();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
    expect(requests).toEqual([]);
  });

  it('observes without processing, then consumes cached evidence when processing is enabled', async () => {
    await seedMelt('PENDING');
    meltState = 'PAID';
    const quote = await coco.quotes.melt.refresh({ mintUrl, quoteId: 'melt' });
    expect(quote.state).toBe('PAID');
    expect(quote.change).toEqual([]); // omitted PAID change is normalized at observation
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
    await coco.enableMeltSettlementProcessor();
    await finishMeltChecks();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/melt/quote/bolt11/melt']);
  });

  it('lets a watcher persist polling evidence while processing is disabled', async () => {
    await seedMelt('PENDING');
    meltState = 'PAID';
    const observed = new Promise<void>((resolve) =>
      coco.on('melt-quote:updated', ({ quote }) => {
        if (quote.state === 'PAID') resolve();
      }),
    );
    await coco.enableMeltQuoteWatcher();
    await observed;
    await coco.disableMeltQuoteWatcher();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('pending');
    expect((await coco.quotes.melt.get({ mintUrl, quoteId: 'melt' }))?.change).toEqual([]);
    expect(requests).toEqual(['/v1/melt/quote/bolt11/melt']);
  });

  it('settles complete polling evidence with both owners enabled without refetching', async () => {
    await seedMelt('PENDING');
    await coco.enableMeltSettlementProcessor();
    meltState = 'PAID';
    const completed = new Promise<void>((resolve) => coco.on('melt-op:finalized', () => resolve()));
    await coco.enableMeltQuoteWatcher();
    await completed;
    await coco.disableMeltQuoteWatcher();
    await finishMeltChecks();
    expect((await coco.ops.melt.get('melt-op'))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/melt/quote/bolt11/melt']);
  });

  it('deduplicates terminal events from overlapping runtime observations', async () => {
    const operation = await seedMelt('PENDING');
    await coco.enableMeltSettlementProcessor();
    await new Promise((resolve) => setTimeout(resolve, 0));
    let finalized = 0;
    coco.on('melt-op:finalized', () => {
      finalized++;
    });
    meltState = 'PAID';
    await Promise.all([
      coco.quotes.melt.refresh({ mintUrl, quoteId: operation.quoteId }),
      coco.quotes.melt.refresh({ mintUrl, quoteId: operation.quoteId }),
    ]);
    await finishMeltChecks();
    expect((await coco.ops.melt.get(operation.id))?.state).toBe('finalized');
    expect(finalized).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('handles newly pending Melts when startup discovery is disabled', async () => {
    await coco.enableMeltSettlementProcessor({ initializeExistingPendingOperationsOnStart: false });
    const quote = meltQuoteFromBolt11Response(mintUrl, {
      ...remoteMelt('UNPAID'),
      amount: Amount.from(1),
      fee_reserve: Amount.zero(),
    });
    await repo.meltQuoteRepository.upsertMeltQuote(quote);
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(1),
        C: keys['1'],
        secret: 'live-melt',
        mintUrl,
        unit: 'sat',
        state: 'ready',
      },
    ]);
    const operation = await coco.ops.melt.prepare({ quote });
    expect((await coco.ops.melt.execute(operation.id)).state).toBe('pending');
    meltState = 'PAID';
    await coco.quotes.melt.refresh({ mintUrl, quoteId: 'melt' });
    await finishMeltChecks();
    expect((await coco.ops.melt.get(operation.id))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/swap', '/v1/melt/bolt11', '/v1/melt/quote/bolt11/melt']);
  });

  it('keeps explicit operation refresh available with both owners disabled', async () => {
    await seedMelt('PAID', true);
    meltState = 'PAID';
    expect((await coco.ops.melt.refresh('melt-op')).state).toBe('finalized');
    expect(requests).toEqual(['/v1/melt/quote/bolt11/melt']);
  });

  it.each(['PAID', 'ISSUED'] as const)(
    'discovers pending Mint operations with cached %s quotes',
    async (state) => {
      const operation = await seedMint();
      await repo.mintQuoteRepository.upsertMintQuote(
        mintQuoteFromBolt11Fixture(mintUrl, {
          ...remoteMint(state),
          state,
          amount: Amount.from(1),
        }),
      );
      mintState = state;
      // Restored proofs must still be unspent for the ISSUED path.
      proofState = 'UNSPENT';
      await coco.enableMintOperationProcessor();
      await coco.waitForMintOperationProcessor();
      expect((await coco.ops.mint.get(operation.id))?.state).toBe('finalized');
      expect(
        (await repo.proofRepository.getProofsByOperationId(mintUrl, operation.id)).some(
          (p) => p.state === 'ready',
        ),
      ).toBe(true);
      expect(requests.some((path) => path.startsWith('/v1/mint/quote/'))).toBe(false);
    },
  );

  it('discovers claimable quote-only Mint records on startup', async () => {
    await repo.mintQuoteRepository.upsertMintQuote(
      mintQuoteFromBolt11Fixture(mintUrl, {
        ...remoteMint('PAID'),
        amount: Amount.from(1),
      }),
    );
    await coco.enableMintOperationProcessor();
    await coco.waitForMintOperationProcessor();
    expect((await coco.ops.mint.listByQuote({ mintUrl, quoteId: 'mint' }))[0]?.state).toBe(
      'finalized',
    );
    expect(requests).toEqual(['/v1/mint/bolt11']);
  });

  it('advances Mint operations from explicit quote observations with its watcher disabled', async () => {
    const operation = await seedMint();
    await coco.enableMintOperationProcessor();
    await coco.waitForMintOperationProcessor();
    expect((await coco.ops.mint.get(operation.id))?.state).toBe('pending');
    await coco.quotes.mint.refresh({ mintUrl, quoteId: 'mint' });
    await coco.waitForMintOperationProcessor();
    expect((await coco.ops.mint.get(operation.id))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/mint/quote/bolt11/mint', '/v1/mint/bolt11']);
  });

  it('persists Mint watcher observations with its processor disabled', async () => {
    const operation = await seedMint();
    const observed = new Promise<void>((resolve) =>
      coco.on('mint-quote:updated', ({ quote }) => {
        if (quote.amountPaid.equals(Amount.from(1))) resolve();
      }),
    );
    await coco.enableMintOperationWatcher();
    await observed;
    await coco.disableMintOperationWatcher();
    expect((await coco.ops.mint.get(operation.id))?.state).toBe('pending');
    expect(requests).toEqual(['/v1/mint/quote/bolt11/mint']);
  });

  it('suppresses automatic startup and live Mint claims while allowing explicit execution', async () => {
    const operation = await seedMint('PAID');
    await coco.enableMintOperationProcessor({ autoClaimMintQuotes: false });
    await coco.quotes.mint.refresh({ mintUrl, quoteId: 'mint' });
    await coco.waitForMintOperationProcessor();
    expect((await coco.ops.mint.get(operation.id))?.state).toBe('pending');
    expect(requests).toEqual(['/v1/mint/quote/bolt11/mint']);
    expect((await coco.ops.mint.execute(operation.id)).state).toBe('finalized');
  });

  it('processes an explicit Mint requeue when automatic claiming is disabled', async () => {
    const operation = await seedMint('PAID');
    await coco.enableMintOperationProcessor({
      autoClaimMintQuotes: false,
      initialEnqueueDelayMs: 0,
    });
    await events.emit('mint-op:requeue', { mintUrl, operationId: operation.id, operation });
    await coco.waitForMintOperationProcessor();
    expect((await coco.ops.mint.get(operation.id))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/mint/bolt11']);
  });

  it('discovers pending Sends with proofs already spent locally', async () => {
    const proof = {
      id: keysetId,
      amount: Amount.from(1),
      C: keys['1'],
      secret: 'sent',
      mintUrl,
      unit: 'sat',
      state: 'spent' as const,
      usedByOperationId: 'send-op',
    };
    await repo.proofRepository.saveProofs(mintUrl, [proof]);
    await repo.sendOperationRepository.create(pendingSend('send-op', [proof]));
    const completed = new Promise<void>((resolve) => coco.on('send:finalized', () => resolve()));
    await coco.enableProofStateWatcher();
    await completed;
    expect((await coco.ops.send.get('send-op'))?.state).toBe('finalized');
    expect(requests).toEqual([]);
  });

  it('keeps live Send observation enabled when startup scanning is disabled', async () => {
    await coco.enableProofStateWatcher({ watchExistingInflightOnStart: false });
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(1),
        C: keys['1'],
        secret: 'live-send',
        mintUrl,
        unit: 'sat',
        state: 'ready',
      },
    ]);
    const operation = await coco.ops.send.prepare({ mintUrl, amount: 1 });
    const completed = new Promise<void>((resolve) => coco.on('send:finalized', () => resolve()));
    await coco.ops.send.execute(operation.id);
    await completed;
    expect((await coco.ops.send.get(operation.id))?.state).toBe('finalized');
    expect(requests).toEqual(['/v1/checkstate']);
  });

  it.each(['disableProofStateWatcher', 'dispose'] as const)(
    'allows an awaited Send completion listener to call %s',
    async (stop) => {
      await coco.enableProofStateWatcher({ watchExistingInflightOnStart: false });
      await repo.proofRepository.saveProofs(mintUrl, [
        {
          id: keysetId,
          amount: Amount.from(1),
          C: keys['1'],
          secret: 'stop-on-completion',
          mintUrl,
          unit: 'sat',
          state: 'ready',
        },
      ]);
      const operation = await coco.ops.send.prepare({ mintUrl, amount: 1 });
      const completed = new Promise<void>((resolve) => {
        coco.on('send:finalized', async () => {
          await coco[stop]();
          resolve();
        });
      });

      await coco.ops.send.execute(operation.id);
      await completed;

      expect((await coco.ops.send.get(operation.id))?.state).toBe('finalized');
      expect(requests).toEqual(['/v1/checkstate']);
    },
  );

  it('discovers legacy tokenless P2PK Sends without retained output proof rows', async () => {
    const output = OutputData.createDeterministicData(Amount.from(1), seed, 0, {
      id: keysetId,
      keys,
    });
    const operation: PendingSendOperation = {
      id: 'legacy-send',
      state: 'pending',
      mintUrl,
      unit: 'sat',
      method: 'p2pk',
      methodData: { pubkey: keys['1'] },
      amount: Amount.from(1),
      fee: Amount.zero(),
      inputAmount: Amount.from(1),
      inputProofSecrets: ['old-input'],
      needsSwap: true,
      outputData: serializeOutputData({ keep: [], send: output }),
      createdAt: 1,
      updatedAt: 2,
    };
    await repo.proofRepository.saveProofs(mintUrl, [
      {
        id: keysetId,
        amount: Amount.from(1),
        C: keys['1'],
        secret: 'old-input',
        mintUrl,
        unit: 'sat',
        state: 'spent',
        usedByOperationId: operation.id,
      },
    ]);
    await repo.sendOperationRepository.create(operation);
    const completed = new Promise<void>((resolve) => coco.on('send:finalized', () => resolve()));
    await coco.enableProofStateWatcher();
    await completed;
    expect((await coco.ops.send.get(operation.id))?.state).toBe('finalized');
    expect(
      await repo.proofRepository.getProofsBySecrets(
        mintUrl,
        output.map((data) => new TextDecoder().decode(data.secret)),
      ),
    ).toEqual([]);
    expect(requests).toEqual(['/v1/checkstate']);
  });
  it('reloads persisted startup evidence in a fresh Session without a recovery sweep', async () => {
    let directory: string | undefined;
    try {
      if (adapter === 'sqlite') {
        await coco.dispose();
        database!.close();
        directory = mkdtempSync(join(tmpdir(), 'coco-background-'));
        database = new Database(join(directory, 'wallet.db'));
        repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
        await repo.init();
      }
      await seedMelt('PAID');
      await coco.dispose();
      if (adapter === 'sqlite') {
        database!.close();
        database = new Database(join(directory!, 'wallet.db'));
        repo = new SqlStorageRepositories({ database: new SqliteDb({ database }) });
        await repo.init();
      }
      // The constructor is the manual Session facade: owners are explicitly started, so startup
      // recovery cannot account for the pending-to-finalized transition asserted here.
      coco = new Manager(repo, async () => seed);
      await coco.enableMeltSettlementProcessor();
      await finishMeltChecks();
      expect((await coco.ops.melt.get('melt-op'))?.state).toBe('finalized');
      expect(requests).toEqual([]);
    } finally {
      if (directory) {
        await coco.dispose();
        database?.close();
        database = undefined;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
