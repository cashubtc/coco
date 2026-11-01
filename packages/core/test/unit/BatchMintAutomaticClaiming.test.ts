import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import type { BatchMintBehavior } from '../fixtures/BatchMintMint.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';
import {
  createBatchMintHarness,
  ownedKey,
  type BatchMintHarness,
} from '../fixtures/BatchMintHarness.ts';

/**
 * Automatic claiming through Batch Mint Operations: the real Mint Operation Processor and startup
 * sweep over Memory repositories and an in-process HTTP mint with real blind signatures.
 */
describe('Automatic Batch Mint claiming', () => {
  let h: BatchMintHarness;

  beforeEach(async () => {
    h = await createBatchMintHarness();
  });

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  const unpaid = async (quote: string, amount = 10) =>
    h.quote({ quote, method: 'bolt11', amount, amountPaid: 0 });

  /** Pay quotes at the mint and observe them through one NUT-29 polling check. */
  const payAndPoll = async (...quoteIds: string[]) => {
    for (const quoteId of quoteIds) {
      const quote = h.mint.quotes.get(quoteId)!;
      quote.amountPaid = quote.amount!;
    }
    const { quoteLifecycle } = h.coco as unknown as {
      quoteLifecycle: {
        checkMintQuotesForPolling(
          method: 'bolt11',
          identities: Array<{ mintUrl: string; quoteId: string }>,
        ): Promise<unknown>;
      };
    };
    await quoteLifecycle.checkMintQuotesForPolling(
      'bolt11',
      quoteIds.map((quoteId) => ({ mintUrl: h.mint.mintUrl, quoteId })),
    );
  };

  const paid = async (quote: string, amount = 10) =>
    h.quote({ quote, method: 'bolt11', amount, amountPaid: amount });

  /** Mint requests by kind, in the order the mint received them. */
  const mintCalls = () =>
    h.mint.requests
      .filter(({ path }) => /^\/v1\/mint\/\w+(\/batch)?$/.test(path))
      .map(({ path, body }) =>
        path.endsWith('/batch')
          ? { batch: (body as { quotes: string[] }).quotes }
          : { single: (body as { quote: string }).quote },
      );

  describe('startup sweep', () => {
    it('claims each chunk within the batch limit as one Batch Mint Operation', async () => {
      for (const quote of ['a', 'b', 'c', 'd']) await paid(quote);

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ batch: ['a', 'b', 'c'] }, { single: 'd' }]);
      const [batch] = await h.coco.ops.mint.batch.listByQuote({
        mintUrl: h.mint.mintUrl,
        quoteId: 'a',
      });
      expect(batch?.state).toBe('finalized');
      expect(
        (await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId: 'd' })).map(
          (operation) => operation.state,
        ),
      ).toEqual(['finalized']);
    });

    it('keeps standalone claims for quotes batching cannot cover', async () => {
      await h.dispose();
      h.uninstall();
      h = await createBatchMintHarness({ nut29: { max_batch_size: 3, methods: ['bolt11'] } });
      await paid('a');
      await paid('b');
      await h.quote({ quote: 'usd', method: 'bolt11', unit: 'usd', amount: 10, amountPaid: 10 });
      await paid('pending');
      await h.coco.ops.mint.prepare({
        quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'pending' },
        amount: 10,
      });
      await paid('swapped');
      await h.repo.mintSwap.operationRepository.create({
        ...mintSwapFixtures('swap').preparing,
        destinationMintUrl: h.mint.mintUrl,
        destinationQuote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'swapped' },
      });
      for (const quote of ['x', 'y'])
        await h.quote({ quote, method: 'bolt12', amountPaid: 10, pubkey: ownedKey.publicKeyHex });

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      const calls = mintCalls();
      expect(calls.filter((call) => 'batch' in call)).toEqual([{ batch: ['a', 'b'] }]);
      expect(
        calls
          .filter((call) => 'single' in call)
          .map((call) => (call as { single: string }).single)
          .sort(),
      ).toEqual(['pending', 'usd', 'x', 'y']);
      expect(h.mint.quotes.get('swapped')!.amountIssued).toBe(0);
    });

    it('claims reusable quotes at their full available amount', async () => {
      for (const quote of ['x', 'y'])
        await h.quote({
          quote,
          method: 'onchain',
          amountPaid: 50,
          amountIssued: 20,
          pubkey: ownedKey.publicKeyHex,
        });

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(
        h.mint.batchRequests.map(({ quotes, quote_amounts }) => [quotes, quote_amounts]),
      ).toEqual([
        [
          ['x', 'y'],
          [30, 30],
        ],
      ]);
      const [batch] = await h.coco.ops.mint.batch.listByQuote({
        mintUrl: h.mint.mintUrl,
        quoteId: 'x',
      });
      expect(batch?.state).toBe('finalized');
      expect(batch?.members.map((member) => member.amount)).toEqual([
        Amount.from(30),
        Amount.from(30),
      ]);
    });
  });

  describe('Mint Operation Processor', () => {
    it('collects claims from quote updates over one processing turn and groups them', async () => {
      for (const quote of ['a', 'b', 'c', 'd']) await unpaid(quote);
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 50 });
      await h.coco.waitForMintOperationProcessor();
      expect(mintCalls()).toEqual([]);

      // A quote paid while the turn's batch is in flight belongs to the next turn.
      h.mint.onBatchIssued = async () => {
        h.mint.onBatchIssued = undefined;
        await payAndPoll('d');
      };
      await payAndPoll('a', 'b');
      await payAndPoll('c');
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ batch: ['a', 'b', 'c'] }, { single: 'd' }]);
    });

    it('claims a quote whose Mint Operation was just prepared without waiting for the turn', async () => {
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 60_000 });
      await h.coco.waitForMintOperationProcessor();
      await paid('p');

      await h.coco.ops.mint.prepare({
        quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'p' },
        amount: 10,
      });
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ single: 'p' }]);
    });

    it('claims still-claimable members of a rejected batch as new standalone Mint Operations', async () => {
      for (const quote of ['a', 'b', 'c']) await paid(quote);
      h.mint.batchBehaviors.push({ code: 20007, detail: 'quote expired' });
      // Another device claims `c` while the batch is being rejected.
      h.coco.on('batch-mint-op:failed', async () => {
        h.mint.quotes.get('c')!.amountIssued = 10;
        await h.persist('c');
      });

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ batch: ['a', 'b', 'c'] }, { single: 'a' }, { single: 'b' }]);
      const [failed] = await h.coco.ops.mint.batch.listByQuote({
        mintUrl: h.mint.mintUrl,
        quoteId: 'a',
      });
      expect(failed?.state).toBe('failed');
      const batchOutputs = new Set(h.mint.batchRequests[0]!.outputs.map((output) => output.B_));
      const singleOutputs = h.mint.requests
        .filter(({ path }) => path === '/v1/mint/bolt11')
        .flatMap(({ body }) => (body as { outputs: Array<{ B_: string }> }).outputs);
      expect(singleOutputs.length).toBeGreaterThan(0);
      expect(singleOutputs.some((output) => batchOutputs.has(output.B_))).toBe(false);
      for (const quoteId of ['a', 'b'])
        expect(
          (await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId })).map(
            (operation) => operation.state,
          ),
        ).toEqual(['finalized']);
      expect(await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId: 'c' })).toEqual(
        [],
      );
    });

    it('claims the members of a batch admission rejected as standalone Mint Operations', async () => {
      for (const quote of ['a', 'b', 'c', 'd', 'e', 'f']) await paid(quote);
      // `e` gains a standalone Mint Operation after the second chunk was grouped.
      h.mint.onBatchIssued = async () => {
        h.mint.onBatchIssued = undefined;
        await h.coco.ops.mint.prepare({
          quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'e' },
          amount: 10,
        });
      };

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(h.mint.batchRequests.map(({ quotes }) => quotes)).toEqual([['a', 'b', 'c']]);
      for (const quoteId of ['d', 'e', 'f'])
        expect(
          (await h.coco.ops.mint.listByQuote({ mintUrl: h.mint.mintUrl, quoteId })).map(
            (operation) => operation.state,
          ),
        ).toEqual(['finalized']);
    });
  });

  describe('batching unavailable marker', () => {
    /** Startup batch of `a` and `b` answered with `behavior`, then a later turn pays `d` and `e`. */
    const runTwoTurns = async (behavior: BatchMintBehavior) => {
      await paid('a');
      await paid('b');
      await unpaid('d');
      await unpaid('e');
      h.mint.batchBehaviors.push(behavior);
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();
      await payAndPoll('d', 'e');
      await h.coco.waitForMintOperationProcessor();
    };

    it('claims standalone for the rest of the session after 11017 and reclaims the failed batch', async () => {
      await runTwoTurns({ code: 11017, detail: 'batch too large' });

      expect(mintCalls()).toEqual([
        { batch: ['a', 'b'] },
        { single: 'a' },
        { single: 'b' },
        { single: 'd' },
        { single: 'e' },
      ]);
      // The quote-check marker of ADR-0006 is separate: polling still checks both quotes at once.
      expect(
        h.mint.requests
          .filter(({ path }) => path === '/v1/mint/quote/bolt11/check')
          .map(({ body }) => (body as { quotes: string[] }).quotes),
      ).toEqual([['d', 'e']]);
    });

    for (const behavior of ['unsupported', 'unparseable', 'wrong-shape'] as const) {
      it(`claims standalone after a ${behavior} response while the ambiguous batch keeps its quotes`, async () => {
        await runTwoTurns(behavior);

        expect(mintCalls()).toEqual([{ batch: ['a', 'b'] }, { single: 'd' }, { single: 'e' }]);
        const [batch] = await h.coco.ops.mint.batch.listByQuote({
          mintUrl: h.mint.mintUrl,
          quoteId: 'a',
        });
        expect(batch?.state).toBe('executing');
      });
    }

    it('claims later chunks standalone once an earlier chunk sets the marker', async () => {
      for (const quote of ['a', 'b', 'c', 'd', 'e']) await paid(quote);
      h.mint.batchBehaviors.push('unsupported');

      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ batch: ['a', 'b', 'c'] }, { single: 'd' }, { single: 'e' }]);
    });

    it('starts a new Coco Session without the marker', async () => {
      await runTwoTurns('unsupported');
      await h.dispose();
      for (const quote of ['f', 'g']) await paid(quote);

      h = await createBatchMintHarness({ repo: h.repo, mint: h.mint });
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      expect(h.mint.batchRequests.map(({ quotes }) => quotes).slice(-1)).toEqual([['f', 'g']]);
    });

    for (const behavior of ['network', 'server', 'unauthorized', 'rate-limited'] as const) {
      it(`keeps batching after a ${behavior} failure`, async () => {
        await runTwoTurns(behavior);

        expect(mintCalls()).toEqual([{ batch: ['a', 'b'] }, { batch: ['d', 'e'] }]);
      });
    }
  });

  describe('configuration and lifecycle', () => {
    it('claims one standalone Mint Operation per quote with batchMintQuotes: false', async () => {
      for (const quote of ['a', 'b']) await paid(quote);
      for (const quote of ['c', 'd', 'e', 'f']) await unpaid(quote);
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20, batchMintQuotes: false });
      await h.coco.waitForMintOperationProcessor();
      await payAndPoll('c', 'd');
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([
        { single: 'a' },
        { single: 'b' },
        { single: 'c' },
        { single: 'd' },
      ]);
      h.mint.quotes.get('e')!.amountPaid = 10;
      h.mint.quotes.get('f')!.amountPaid = 10;
      await h.persist('e');
      await h.persist('f');
      const explicit = await h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'e' }, { quoteId: 'f' }],
      });
      expect(explicit.state).toBe('finalized');
    });

    it('discards collected claims on stop, and the next start claims them together', async () => {
      for (const quote of ['a', 'b', 'c']) await unpaid(quote);
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();

      // Resolves once the stop started mid-batch has drained the processor's owned work.
      const stopped = new Promise<void>((resolve) => {
        h.mint.onBatchIssued = async () => {
          h.mint.onBatchIssued = undefined;
          // `c` is collected for the next turn, then the processor stops mid-batch.
          await payAndPoll('c');
          resolve(h.coco.disableMintOperationProcessor());
        };
      });
      await payAndPoll('a', 'b');
      await stopped;

      // The submitted batch completed; the collected claim for `c` was not started.
      expect(mintCalls()).toEqual([{ batch: ['a', 'b'] }]);

      // The next start's sweep finds `c` still unclaimed and claims it with `d`.
      await paid('d');
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 20 });
      await h.coco.waitForMintOperationProcessor();
      expect(mintCalls()).toEqual([{ batch: ['a', 'b'] }, { batch: ['c', 'd'] }]);
    });

    it('discards collected claims for a mint that is untrusted, even if trusted again', async () => {
      for (const quote of ['a', 'b']) await unpaid(quote);
      await h.coco.enableMintOperationProcessor({ processIntervalMs: 50 });
      await h.coco.waitForMintOperationProcessor();

      await unpaid('c');
      await payAndPoll('a', 'b');
      await h.coco.mint.untrustMint(h.mint.mintUrl);
      await h.coco.mint.trustMint(h.mint.mintUrl);
      // `c` joins the same turn; waiting for it to be claimed waits for the whole turn to end.
      await payAndPoll('c');
      await h.coco.waitForMintOperationProcessor();

      expect(mintCalls()).toEqual([{ single: 'c' }]);
    });
  });
});
