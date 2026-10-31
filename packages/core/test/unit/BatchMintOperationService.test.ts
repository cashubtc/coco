import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  BatchMintAdmissionError,
  MintQuoteKeyError,
  UnknownMintError,
} from '../../models/Error.ts';
import {
  createBatchMintHarness,
  foreignKey,
  ownedKey,
  type BatchMintHarness,
} from '../fixtures/BatchMintHarness.ts';

/**
 * Batch Mint Operations at the coordinator boundary: a real Manager over Memory repositories and
 * an in-process HTTP mint with real blind signatures and NUT-20 verification.
 */
describe('Batch Mint Operations', () => {
  let h: BatchMintHarness;

  beforeEach(async () => {
    h = await createBatchMintHarness();
  });

  afterEach(async () => {
    await h.dispose();
    h.uninstall();
  });

  describe('execution', () => {
    it('claims paid BOLT11 quotes in one exact NUT-29 request and finalizes atomically', async () => {
      await h.quote({ quote: 'q-unlocked', method: 'bolt11', amount: 10, amountPaid: 10 });
      await h.quote({
        quote: 'q-locked',
        method: 'bolt11',
        amount: 20,
        amountPaid: 20,
        pubkey: ownedKey.publicKeyHex,
      });

      const operation = await h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'q-locked' }, { quoteId: 'q-unlocked' }],
      });

      expect(operation.state).toBe('finalized');
      expect(operation.members.map((m) => [m.ordinal, m.quoteId, m.amount.toString()])).toEqual([
        [0, 'q-locked', '20'],
        [1, 'q-unlocked', '10'],
      ]);
      expect(h.mint.batchRequests).toHaveLength(1);
      const request = h.mint.batchRequests[0]!;
      expect(request.quotes).toEqual(['q-locked', 'q-unlocked']);
      expect(request.quote_amounts).toEqual([20, 10]);
      expect(request.outputs.map((o) => o.B_)).toEqual(
        operation.outputData.keep.map((o) => o.blindedMessage.B_),
      );
      expect(request.signatures?.[0]).toEqual(expect.any(String));
      expect(request.signatures?.[1]).toBeNull();

      const proofs = await h.repo.proofRepository.getProofsByOperationId(
        h.mint.mintUrl,
        operation.id,
      );
      expect(proofs.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(30);
      expect(proofs.every((p) => p.state === 'ready')).toBe(true);
      expect(h.eventNames()).toEqual(['batch-mint-op:executing', 'batch-mint-op:finalized']);
    });

    it('issues one optimised output set for the combined amount, with no prior quote check', async () => {
      for (const quote of ['a', 'b', 'c'])
        await h.quote({ quote, method: 'bolt11', amount: 21, amountPaid: 21 });

      const operation = await h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: ['a', 'b', 'c'].map((quoteId) => ({ quoteId })),
      });

      // Three separate splits of 21 (16 + 4 + 1) would need nine outputs.
      expect(
        h.mint.batchRequests[0]!.outputs.map((o) => Number(o.amount)).sort((x, y) => y - x),
      ).toEqual([32, 16, 8, 4, 2, 1]);
      expect(
        await h.repo.proofRepository.getProofsByOperationId(h.mint.mintUrl, operation.id),
      ).toHaveLength(6);
      expect(h.mint.requests.filter((r) => r.path.startsWith('/v1/mint/quote/'))).toEqual([]);
    });

    for (const method of ['bolt12', 'onchain'] as const) {
      it(`claims ${method} members at their full available amount unless one is given`, async () => {
        await h.quote({
          quote: `${method}-a`,
          method,
          amountPaid: 50,
          amountIssued: 20,
          pubkey: ownedKey.publicKeyHex,
        });
        await h.quote({
          quote: `${method}-b`,
          method,
          amountPaid: 40,
          pubkey: ownedKey.publicKeyHex,
        });

        const operation = await h.coco.ops.mint.batch.execute({
          mintUrl: h.mint.mintUrl,
          method,
          members: [{ quoteId: `${method}-a` }, { quoteId: `${method}-b`, amount: 15 }],
        });

        expect(operation.state).toBe('finalized');
        expect(h.mint.batchRequests[0]!.quote_amounts).toEqual([30, 15]);
        expect(h.mint.batchRequests[0]!.signatures).toHaveLength(2);
        expect(h.mint.quotes.get(`${method}-b`)!.amountIssued).toBe(15);
        expect(
          (
            await h.coco.ops.mint.batch.listByQuote({
              mintUrl: h.mint.mintUrl,
              quoteId: `${method}-b`,
            })
          ).map((op) => op.id),
        ).toEqual([operation.id]);
      });
    }
  });

  describe('admission', () => {
    const paidBolt11 = (quote: string, extra: Record<string, unknown> = {}) =>
      h.quote({ quote, method: 'bolt11', amount: 10, amountPaid: 10, ...extra });

    const expectNothingPersisted = async (quoteIds: string[]) => {
      expect(h.mint.batchRequests).toHaveLength(0);
      expect(await h.coco.ops.mint.batch.listInFlight()).toEqual([]);
      for (const quoteId of quoteIds)
        expect(
          await h.coco.ops.mint.batch.listByQuote({ mintUrl: h.mint.mintUrl, quoteId }),
        ).toEqual([]);
      expect(h.eventNames()).toEqual([]);
    };

    const cases: Array<{
      name: string;
      setup: () => Promise<unknown>;
      members: Array<{ quoteId: string; amount?: number }>;
      method?: 'bolt11' | 'bolt12';
      error: (error: unknown) => boolean;
    }> = [
      {
        name: 'fewer than 2 members',
        setup: () => paidBolt11('a'),
        members: [{ quoteId: 'a' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'too_few_members',
      },
      {
        name: 'duplicate members',
        setup: () => paidBolt11('a'),
        members: [{ quoteId: 'a' }, { quoteId: 'a' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'duplicate_member',
      },
      {
        name: 'mixed units',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b', { unit: 'usd' });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'mixed_unit',
      },
      {
        name: 'mixed methods',
        setup: async () => {
          await paidBolt11('a');
          await h.quote({
            quote: 'b',
            method: 'bolt12',
            amountPaid: 5,
            pubkey: ownedKey.publicKeyHex,
          });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'mixed_method',
      },
      {
        name: 'an untrusted mint',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b');
          await h.coco.mint.untrustMint(h.mint.mintUrl);
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof UnknownMintError,
      },
      {
        name: 'a method the mint does not advertise for NUT-29',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b');
          const mint = await h.repo.mintRepository.getMintByUrl(h.mint.mintUrl);
          const nuts = { ...mint.mintInfo.nuts, '29': { methods: ['bolt12'] } };
          await h.repo.mintRepository.updateMint({ ...mint, mintInfo: { ...mint.mintInfo, nuts } });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'unsupported_method',
      },
      ...(
        [
          ['a malformed', 'ten'],
          ['a single-quote', 1],
        ] as const
      ).map(([kind, maxBatchSize]) => ({
        name: `${kind} NUT-29 batch limit`,
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b');
          const mint = await h.repo.mintRepository.getMintByUrl(h.mint.mintUrl);
          const nuts = {
            ...mint.mintInfo.nuts,
            // Mint info is stored as received, so a malformed limit reaches admission.
            '29': { methods: ['bolt11'], max_batch_size: maxBatchSize as number },
          };
          await h.repo.mintRepository.updateMint({ ...mint, mintInfo: { ...mint.mintInfo, nuts } });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e: unknown) =>
          e instanceof BatchMintAdmissionError && e.reason === 'unsupported_method',
      })),
      {
        name: 'a group above the NUT-29 limit',
        setup: async () => {
          for (const quote of ['a', 'b', 'c', 'd']) await paidBolt11(quote);
        },
        members: ['a', 'b', 'c', 'd'].map((quoteId) => ({ quoteId })),
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'batch_too_large',
      },
      {
        name: 'an unclaimable member',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b', { amountPaid: 0 });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) =>
          e instanceof BatchMintAdmissionError && e.reason === 'unclaimable' && e.quoteId === 'b',
      },
      {
        name: 'a BOLT11 amount mismatch',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b');
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b', amount: 5 }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'amount_mismatch',
      },
      {
        name: 'a quote with a nonterminal standalone Mint Operation',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b');
          await h.coco.ops.mint.prepare({
            quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'b' },
            amount: 10,
          });
          h.events.length = 0;
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof BatchMintAdmissionError && e.reason === 'standalone_operation',
      },
      {
        name: 'a locked quote whose key the Wallet does not own',
        setup: async () => {
          await paidBolt11('a');
          await paidBolt11('b', { pubkey: foreignKey.publicKeyHex });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof MintQuoteKeyError,
      },
      {
        name: 'a reusable quote without a quote key',
        method: 'bolt12',
        setup: async () => {
          await h.quote({
            quote: 'a',
            method: 'bolt12',
            amountPaid: 5,
            pubkey: ownedKey.publicKeyHex,
          });
          await h.quote({ quote: 'b', method: 'bolt12', amountPaid: 5 });
        },
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
        error: (e) => e instanceof MintQuoteKeyError,
      },
    ];

    for (const testCase of cases) {
      it(`rejects ${testCase.name} before persisting anything`, async () => {
        await testCase.setup();
        const error = await h.coco.ops.mint.batch
          .execute({
            mintUrl: h.mint.mintUrl,
            method: testCase.method ?? 'bolt11',
            members: testCase.members,
          })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        expect(error).toBeDefined();
        expect(testCase.error(error)).toBe(true);
        await expectNothingPersisted(testCase.members.map((m) => m.quoteId));
      });
    }
  });

  describe('outcomes and recovery', () => {
    const setupPair = async () => {
      await h.quote({ quote: 'a', method: 'bolt11', amount: 10, amountPaid: 10 });
      await h.quote({
        quote: 'b',
        method: 'bolt11',
        amount: 20,
        amountPaid: 20,
        pubkey: ownedKey.publicKeyHex,
      });
    };
    const executePair = () =>
      h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'a' }, { quoteId: 'b' }],
      });
    const savedProofs = (operationId: string) =>
      h.repo.proofRepository.getProofsByOperationId(h.mint.mintUrl, operationId);

    beforeEach(setupPair);

    it('marks a definitive rejection failed and releases its reservations without fallback', async () => {
      h.mint.batchBehaviors.push({ code: 20007, detail: 'quote expired' });

      const operation = await executePair();

      expect(operation.state).toBe('failed');
      expect(operation.state === 'failed' && operation.terminalFailure.code).toBe('20007');
      expect(h.mint.batchRequests).toHaveLength(1);
      expect(h.eventNames()).toEqual(['batch-mint-op:executing', 'batch-mint-op:failed']);
      expect(await savedProofs(operation.id)).toEqual([]);
      // Released: a standalone Mint Operation can now claim the member.
      const standalone = await h.coco.ops.mint.prepare({
        quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'a' },
        amount: 10,
      });
      expect((await h.coco.ops.mint.execute(standalone.id)).state).toBe('finalized');
    });

    for (const code of [
      11005, 11006, 11008, 11009, 11010, 11012, 11014, 11015, 11016, 11017, 12001, 12002, 12003,
      20001, 20003, 20007, 20008, 20009,
    ]) {
      it(`fails the batch on the definitive rejection code ${code}`, async () => {
        h.mint.batchBehaviors.push({ code });

        const operation = await executePair();

        expect(operation.state === 'failed' && operation.terminalFailure.code).toBe(String(code));
      });
    }

    for (const [name, behavior] of [
      ['a network failure', 'network'],
      ['a server error', 'server'],
      ['a lost response after issuance', 'issue-then-drop'],
      ['an invalid success response', 'short'],
      ['"quote already issued", which may follow issuance', { code: 20002 }],
      ['"outputs already signed", which may follow issuance', { code: 10002 }],
      ['an unknown error code', { code: 19999 }],
    ] as const) {
      it(`leaves ${name} executing and returns it`, async () => {
        h.mint.batchBehaviors.push(behavior);

        const operation = await executePair();

        expect(operation.state).toBe('executing');
        expect(operation.error).toEqual(expect.any(String));
        expect(await savedProofs(operation.id)).toEqual([]);
        expect(await h.coco.ops.mint.batch.listInFlight()).toEqual([operation]);
        expect(h.eventNames()).toEqual(['batch-mint-op:executing']);
        // Its reservation still blocks standalone claims.
        await expect(
          h.coco.ops.mint.prepare({
            quote: { mintUrl: h.mint.mintUrl, method: 'bolt11', quoteId: 'a' },
            amount: 10,
          }),
        ).rejects.toThrow(`already claimed by Batch Mint Operation ${operation.id}`);
      });
    }

    it('retries locked members with the legacy signature on a mint that predates the amended one', async () => {
      h.mint.quoteSignatureFormat = 'legacy';

      const operation = await executePair();

      expect(operation.state).toBe('finalized');
      const [amended, legacy] = h.mint.batchRequests;
      expect(h.mint.batchRequests).toHaveLength(2);
      expect(legacy!.outputs).toEqual(amended!.outputs);
      expect(legacy!.signatures![0]).toBeNull();
      expect(legacy!.signatures![1]).not.toBe(amended!.signatures![1]);
    });

    it('recovers an issued batch through Restore without resubmitting', async () => {
      h.mint.batchBehaviors.push('issue-then-drop');
      const executing = await executePair();

      await h.coco.ops.mint.batch.recovery.run();

      const recovered = await h.coco.ops.mint.batch.get(executing.id);
      expect(recovered?.state).toBe('finalized');
      expect(recovered?.error).toBeUndefined();
      expect(h.mint.batchRequests).toHaveLength(1);
      expect((await savedProofs(executing.id)).reduce((sum, p) => sum + Number(p.amount), 0)).toBe(
        30,
      );
      expect(h.eventNames()).toEqual(['batch-mint-op:executing', 'batch-mint-op:finalized']);

      // Repeated recovery is a no-op.
      await h.coco.ops.mint.batch.recovery.run();
      expect(h.mint.requests.filter((r) => r.path === '/v1/restore')).toHaveLength(1);
    });

    it('replays the exact request when nothing was restored and every member is claimable', async () => {
      h.mint.batchBehaviors.push('network');
      const executing = await executePair();

      await h.coco.ops.mint.batch.recovery.run();

      expect((await h.coco.ops.mint.batch.get(executing.id))?.state).toBe('finalized');
      expect(h.mint.batchRequests).toHaveLength(2);
      const [first, replay] = h.mint.batchRequests;
      expect(replay!.quotes).toEqual(first!.quotes);
      expect(replay!.quote_amounts).toEqual(first!.quote_amounts);
      expect(replay!.outputs).toEqual(first!.outputs);
      const paths = h.mint.requests.map((r) => r.path);
      expect(paths.indexOf('/v1/restore')).toBeLessThan(paths.indexOf('/v1/mint/quote/bolt11/a'));
      expect(paths.indexOf('/v1/mint/quote/bolt11/a')).toBeLessThan(
        paths.indexOf('/v1/mint/quote/bolt11/b'),
      );
      expect(paths.lastIndexOf('/v1/mint/bolt11/batch')).toBeGreaterThan(
        paths.indexOf('/v1/mint/quote/bolt11/b'),
      );
    });

    it('records Quote Observations and fails when nothing was restored and a member is unclaimable', async () => {
      h.mint.batchBehaviors.push('network');
      const executing = await executePair();
      // Another wallet claimed quote b in the meantime.
      h.mint.quotes.get('b')!.amountIssued = 20;

      await h.coco.ops.mint.batch.recovery.run();

      const failed = await h.coco.ops.mint.batch.get(executing.id);
      expect(failed?.state).toBe('failed');
      expect(h.mint.batchRequests).toHaveLength(1);
      const observed = await h.coco.quotes.mint.get({ mintUrl: h.mint.mintUrl, quoteId: 'b' });
      expect(observed?.amountIssued.toString()).toBe('20');
      expect(h.eventNames()).toEqual(['batch-mint-op:executing', 'batch-mint-op:failed']);
    });

    for (const [name, arrange] of [
      ['a partial Restore', () => (h.mint.restoreBehavior = 'partial')],
      ['an unavailable Restore', () => (h.mint.restoreBehavior = 'unavailable')],
      ['an unavailable quote check', () => (h.mint.quoteCheckBehavior = 'unavailable')],
    ] as const) {
      it(`stays executing after ${name}`, async () => {
        h.mint.batchBehaviors.push(
          name === 'an unavailable quote check' ? 'network' : 'issue-then-drop',
        );
        const executing = await executePair();
        arrange();

        await h.coco.ops.mint.batch.recovery.run();

        const current = await h.coco.ops.mint.batch.get(executing.id);
        expect(current?.state).toBe('executing');
        expect(h.mint.batchRequests).toHaveLength(1);
        expect(await savedProofs(executing.id)).toEqual([]);
      });
    }

    it('leaves an executing batch alone while its mint is untrusted', async () => {
      h.mint.batchBehaviors.push('issue-then-drop');
      const executing = await executePair();
      await h.coco.mint.untrustMint(h.mint.mintUrl);
      const requestsBefore = h.mint.requests.length;

      await h.coco.ops.mint.batch.recovery.run();

      expect((await h.coco.ops.mint.batch.get(executing.id))?.state).toBe('executing');
      expect(h.mint.requests.slice(requestsBefore)).toEqual([]);
    });

    it('finalizes from proofs already saved locally without restoring again', async () => {
      h.mint.batchBehaviors.push('issue-then-drop');
      const executing = await executePair();
      // A wallet Restore saves the issued outputs independently of the operation.
      await h.coco.wallet.restore(h.mint.mintUrl);
      const restoreCalls = h.mint.requests.filter((r) => r.path === '/v1/restore').length;
      expect(
        await h.repo.proofRepository.getProofBySecret(
          h.mint.mintUrl,
          new TextDecoder().decode(
            Uint8Array.from(Buffer.from(executing.outputData.keep[0]!.secret, 'hex')),
          ),
        ),
      ).not.toBeNull();

      await h.coco.ops.mint.batch.recovery.run();

      expect((await h.coco.ops.mint.batch.get(executing.id))?.state).toBe('finalized');
      expect(h.mint.requests.filter((r) => r.path === '/v1/restore')).toHaveLength(restoreCalls);
      expect(h.mint.batchRequests).toHaveLength(1);
    });

    it('rolls back and recovers when applying a received result fails before commit', async () => {
      // Fail the first proof write inside a Wallet transaction, after the mint responded.
      const withTransaction = h.repo.withTransaction.bind(h.repo);
      let failOnce = true;
      h.repo.withTransaction = (work) =>
        withTransaction((scope) =>
          work(
            new Proxy(scope, {
              get(target, property, receiver) {
                const value = Reflect.get(target, property, receiver);
                if (property !== 'proofRepository') return value;
                return new Proxy(value, {
                  get(proofs, name, proofsReceiver) {
                    const method = Reflect.get(proofs, name, proofsReceiver);
                    if (name !== 'saveProofs' || !failOnce) return method;
                    return async () => {
                      failOnce = false;
                      throw new Error('disk full');
                    };
                  },
                });
              },
            }),
          ),
        );

      const operation = await executePair();

      expect(operation.state).toBe('executing');
      expect(operation.error).toContain('disk full');
      expect(await savedProofs(operation.id)).toEqual([]);
      expect(h.mint.quotes.get('a')!.amountIssued).toBe(10);

      await h.coco.ops.mint.batch.recovery.run();
      expect((await h.coco.ops.mint.batch.get(operation.id))?.state).toBe('finalized');
      expect(h.mint.batchRequests).toHaveLength(1);
    });

    it('recovers at startup with Mint recovery after an interruption before the response', async () => {
      h.mint.batchBehaviors.push('issue-then-drop');
      const executing = await executePair();
      await h.dispose();

      const restarted = await createBatchMintHarness({ repo: h.repo, mint: h.mint });
      try {
        expect((await restarted.coco.ops.mint.batch.get(executing.id))?.state).toBe('finalized');
        expect(h.mint.batchRequests).toHaveLength(1);
      } finally {
        await restarted.dispose();
      }
    });
  });

  describe('history and events', () => {
    it('projects each member as its own mint history entry and publishes batch events only', async () => {
      await h.quote({ quote: 'a', method: 'bolt11', amount: 10, amountPaid: 10 });
      await h.quote({ quote: 'b', method: 'bolt11', amount: 20, amountPaid: 20 });

      const operation = await h.coco.ops.mint.batch.execute({
        mintUrl: h.mint.mintUrl,
        method: 'bolt11',
        members: [{ quoteId: 'b' }, { quoteId: 'a' }],
      });

      const history = await h.coco.history.getPaginatedHistory();
      expect(history.map((entry) => entry.id)).toEqual([
        `batch-mint:${operation.id}:1`,
        `batch-mint:${operation.id}:0`,
      ]);

      const updates = h.events
        .filter((e) => e.event === 'history:updated')
        .map((e) => {
          const entry = (e.payload as { entry: { id: string; state: string } }).entry;
          return [entry.id, entry.state];
        });
      expect(updates).toEqual([
        [`batch-mint:${operation.id}:0`, 'executing'],
        [`batch-mint:${operation.id}:1`, 'executing'],
        [`batch-mint:${operation.id}:0`, 'finalized'],
        [`batch-mint:${operation.id}:1`, 'finalized'],
      ]);
      const finalized = h.events.find((e) => e.event === 'batch-mint-op:finalized')!.payload as {
        operation: { members: Array<{ quoteId: string }> };
      };
      expect(finalized.operation.members.map((m) => m.quoteId)).toEqual(['b', 'a']);
      expect(h.events.some((e) => e.event.startsWith('mint-op:'))).toBe(false);
    });
  });
});
