import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { mintFixture } from '../helpers/mintReconciliation.ts';

for (const method of ['bolt11', 'bolt12', 'onchain'] as const)
  describe(`Mint reconciliation (${method})`, () => {
    it('claims available accounting after expiry through the real SDK and commits proofs', async () => {
      const f = await mintFixture(method);
      await f.accounting(100, 40);
      const [operation] = await f.service.claimMintQuote(f.mintUrl, method, 'quote');
      expect(operation?.state).toBe('finalized');
      expect(operation?.amount.toString()).toBe('60');
      expect(
        Amount.sum(
          (await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).map((p) => p.amount),
        ).toString(),
      ).toBe('60');
      expect((await f.quote()).amountIssued.toString()).toBe('40'); // No fabricated remote accounting.
      expect(await f.service.claimMintQuote(f.mintUrl, method, 'quote')).toEqual([]);
    });
    it('recovers a lost response with exact-output Restore before consulting quote totals', async () => {
      const f = await mintFixture(method);
      f.control.issue = 'lost';
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      const result = await f.service.execute(operation.id);
      expect(result.state).toBe('finalized');
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(1);
      expect(f.calls.some((c) => c.path === '/v1/restore')).toBe(true);
    });
    it('retains the immutable request and full reservation after empty Restore and restart', async () => {
      const f = await mintFixture(method);
      f.control.issue = 'timeout';
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      await expect(f.service.execute(operation.id)).rejects.toThrow('Network timeout');
      const request = (await f.repositories.mintRecoveryRepository.get(operation.id))!.request;
      await f.accounting(100, 40);
      const restart = f.restart();
      expect((await restart.execute(operation.id)).state).toBe('executing');
      expect((await restart.getOperation(operation.id))!.amount.toString()).toBe('100');
      expect((await f.repositories.mintRecoveryRepository.get(operation.id))!.request).toEqual(
        request,
      );
      expect(await restart.claimMintQuote(f.mintUrl, method, 'quote')).toEqual([]);
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(1);
    });
    it('does not finalize unrelated outputs when a quote is already issued', async () => {
      const f = await mintFixture(method);
      f.control.issue = 'issued';
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      await expect(f.service.execute(operation.id)).rejects.toThrow('already issued');
      expect((await f.service.getOperation(operation.id))?.state).toBe('executing');
      expect(await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).toEqual([]);
    });
    it('keeps partial evidence unresolved without releasing a reservation or crediting twice', async () => {
      const f = await mintFixture(method);
      f.control.issue = 'partial';
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      await expect(f.service.execute(operation.id)).rejects.toThrow();
      const recovery = await f.repositories.mintRecoveryRepository.get(operation.id);
      expect(recovery!.receipts).toHaveLength(1);
      expect((await f.service.getOperation(operation.id))!.state).toBe('executing');
      expect(await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).toEqual([]);
      await f.restart().execute(operation.id);
      expect(
        (await f.repositories.mintRecoveryRepository.get(operation.id))!.receipts,
      ).toHaveLength(1);
    });
    it.each(['SPENT', 'PENDING', 'fail'] as const)(
      'keeps %s restored proofs out of ready balance while finalizing proven issuance',
      async (state) => {
        const f = await mintFixture(method);
        f.control.issue = 'lost';
        f.control.proofState = state;
        const operation = await f.service.prepare(await f.quote(), Amount.from(100));
        expect((await f.service.execute(operation.id)).state).toBe('finalized');
        expect(await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).toEqual([]);
        if (state !== 'SPENT') {
          f.control.proofState = 'UNSPENT';
          await f.restart().recoverPendingOperations();
          expect(
            Amount.sum(
              (await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).map((p) => p.amount),
            ).toString(),
          ).toBe('100');
          await f.restart().recoverPendingOperations();
          expect(
            Amount.sum(
              (await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).map((p) => p.amount),
            ).toString(),
          ).toBe('100');
        }
      },
    );
    it.each(['duplicate', 'wrong-amount', 'fail'] as const)(
      'does not confuse %s Restore with non-issuance',
      async (restore) => {
        const f = await mintFixture(method);
        f.control.issue = 'lost';
        f.control.restore = restore;
        const operation = await f.service.prepare(await f.quote(), Amount.from(100));
        await expect(f.service.execute(operation.id)).rejects.toThrow();
        expect((await f.service.getOperation(operation.id))?.state).toBe('executing');
        expect(await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).toEqual([]);
      },
    );
    it('serializes independent coordinators authorizing the same quote balance', async () => {
      const f = await mintFixture(method);
      const first = await f.service.prepare(await f.quote(), Amount.from(100));
      const second = await f.restart().prepare(await f.quote(), Amount.from(100));
      const results = await Promise.all([
        f.service.execute(first.id),
        f.restart().execute(second.id),
      ]);
      expect(results.map((r) => r.state).sort()).toEqual(['finalized', 'pending']);
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(1);
    });
    it('retains an executing reservation when recovery races an unfinished transmission', async () => {
      const f = await mintFixture(method);
      let start!: () => void, finish!: () => void;
      const started = new Promise<void>((r) => (start = r));
      const waiting = new Promise<void>((r) => (finish = r));
      f.control.beforeIssue = async () => {
        start();
        await waiting;
      };
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      const executing = f.service.execute(operation.id);
      await started;
      expect((await f.restart().execute(operation.id)).state).toBe('executing');
      expect(await f.restart().claimMintQuote(f.mintUrl, method, 'quote')).toEqual([]);
      finish();
      expect((await executing).state).toBe('finalized');
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(1);
    });
    it('does not repeat remote effects when an event listener fails after commit', async () => {
      const f = await mintFixture(method);
      f.events.on('mint-op:executing', () => {
        throw new Error('listener failed');
      });
      f.events.on('proofs:saved', () => {
        throw new Error('listener failed');
      });
      const operation = await f.service.prepare(await f.quote(), Amount.from(100));
      expect((await f.service.execute(operation.id)).state).toBe('finalized');
      expect((await f.restart().execute(operation.id)).state).toBe('finalized');
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(1);
    });
    it('migrates all legacy pending sibling commitments before automatic admission', async () => {
      const f = await mintFixture(method);
      const template = await f.service.prepare(await f.quote(), Amount.from(100));
      await f.repositories.mintOperationRepository.update({ ...template, state: 'failed' });
      await f.repositories.mintOperationRepository.create({ ...template, id: 'legacy-one' });
      await f.repositories.mintOperationRepository.create({ ...template, id: 'legacy-two' });
      expect(await f.restart().claimMintQuote(f.mintUrl, method, 'quote')).toEqual([]);
      expect((await f.repositories.mintRecoveryRepository.get('legacy-one'))!.provenance).toBe(
        'legacy-unknown',
      );
      expect((await f.repositories.mintRecoveryRepository.get('legacy-two'))!.provenance).toBe(
        'legacy-unknown',
      );
      expect(f.calls.filter((c) => c.path === `/v1/mint/${method}`)).toHaveLength(0);
    });
    if (method !== 'bolt11')
      it('persists a rejected current signature before submitting the legacy variant', async () => {
        const f = await mintFixture(method);
        f.control.issue = 'legacy';
        const operation = await f.service.prepare(await f.quote(), Amount.from(100));
        expect((await f.service.execute(operation.id)).state).toBe('finalized');
        const recovery = (await f.repositories.mintRecoveryRepository.get(operation.id))!;
        const bodies = f.calls.filter((c) => c.path === `/v1/mint/${method}`).map((c) => c.body);
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toEqual(JSON.parse(JSON.stringify(recovery.rejectedRequest)));
        expect(bodies[1]).toEqual(JSON.parse(JSON.stringify(recovery.request)));
      });
  });

describe('Legacy BOLT11 compatibility', () => {
  it('issues a normal invoice once in full on a full-only mint', async () => {
    const f = await mintFixture();
    f.control.fullOnly = true;
    const [operation] = await f.service.claimMintQuote(f.mintUrl, 'bolt11', 'quote');
    expect(operation?.amount.toString()).toBe('100');
    expect(operation?.state).toBe('finalized');
  });
  it('surfaces rejection of an explicit partial request without enlarging its amount', async () => {
    const f = await mintFixture();
    f.control.fullOnly = true;
    const operation = await f.service.prepare(await f.quote(), Amount.from(60));
    const result = await f.service.execute(operation.id);
    expect(result.state).toBe('failed');
    expect(result.amount.toString()).toBe('60');
    expect(f.calls.filter((c) => c.path === '/v1/mint/bolt11')).toHaveLength(1);
  });
});

describe('Mint transaction failure boundaries', () => {
  it('rolls back output allocation when preparation cannot persist its operation', async () => {
    const f = await mintFixture();
    const quote = await f.quote();
    const preflight = await f.remote.preflight(quote, Amount.from(100));
    await f.transactions.prepare({ ...preflight, id: 'same-id', quote, amount: Amount.from(100) });
    const before = await f.repositories.counterRepository.getCounter(f.mintUrl, f.keysetId);
    await expect(
      f.transactions.prepare({ ...preflight, id: 'same-id', quote, amount: Amount.from(100) }),
    ).rejects.toThrow();
    expect(await f.repositories.counterRepository.getCounter(f.mintUrl, f.keysetId)).toEqual(
      before,
    );
  });
  it('atomically rolls back proof writes if finalization cannot commit, then recovers after restart', async () => {
    const f = await mintFixture();
    const operation = await f.service.prepare(await f.quote(), Amount.from(100));
    const material = await f.remote.prepareRequest(operation);
    const authorized = await f.transactions.authorize({ operationId: operation.id, ...material });
    const receipts = await f.remote.issue(operation, authorized.recovery!);
    const original = f.repositories.withTransaction.bind(f.repositories);
    f.repositories.withTransaction = (command) =>
      original(async (scope) => {
        const update = scope.mintOperationRepository.update.bind(scope.mintOperationRepository);
        scope.mintOperationRepository.update = async (op) => {
          if (op.state === 'finalized') throw new Error('injected finalization failure');
          return update(op);
        };
        return command(scope);
      });
    await expect(f.transactions.applyEvidence(operation.id, receipts)).rejects.toThrow('injected');
    expect(await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).toEqual([]);
    expect((await f.repositories.mintRecoveryRepository.get(operation.id))!.receipts).toEqual([]);
    expect((await f.service.getOperation(operation.id))!.state).toBe('executing');
    f.repositories.withTransaction = original;
    expect((await f.restart().execute(operation.id)).state).toBe('finalized');
  });
  it('retains authorization after a crash before transmission rather than inventing non-submission', async () => {
    const f = await mintFixture();
    const operation = await f.service.prepare(await f.quote(), Amount.from(100));
    await f.transactions.authorize({
      operationId: operation.id,
      ...(await f.remote.prepareRequest(operation)),
    });
    expect((await f.restart().execute(operation.id)).state).toBe('executing');
    expect(f.calls.filter((c) => c.path === '/v1/mint/bolt11')).toHaveLength(0);
  });
  it('preserves sibling baselines when concurrent claims settle or fail', async () => {
    const f = await mintFixture();
    await f.accounting(100, 40);
    const a = await f.service.prepare(await f.quote(), Amount.from(30));
    const b = await f.service.prepare(await f.quote(), Amount.from(30));
    const first = await f.transactions.authorize({
      operationId: a.id,
      ...(await f.remote.prepareRequest(a)),
    });
    const second = await f.transactions.authorize({
      operationId: b.id,
      ...(await f.remote.prepareRequest(b)),
    });
    await f.transactions.reject(a.id, first.recovery!.revision, 'definitive rejection', false);
    const receipts = await f.remote.issue(b, second.recovery!);
    await f.transactions.applyEvidence(b.id, receipts);
    expect(
      (await f.service.getMintQuoteClaimability(
        f.mintUrl,
        'bolt11',
        'quote',
      ))!.claimAmount?.toString(),
    ).toBe('30');
  });
});

describe('SDK quote compatibility', () => {
  it.each([
    ['UNPAID', '0', '0'],
    ['PAID', '100', '0'],
    ['ISSUED', '100', '100'],
  ] as const)('normalizes old BOLT11 %s responses at the SDK seam', async (state, paid, issued) => {
    const f = await mintFixture();
    f.control.legacyQuoteState = state;
    const quote = await f.wallet.checkMintQuoteBolt11('quote');
    expect(quote.amount_paid.toString()).toBe(paid);
    expect(quote.amount_issued.toString()).toBe(issued);
  });
  it('completes an already prepared request on its historical inactive keyset', async () => {
    const f = await mintFixture();
    const operation = await f.service.prepare(await f.quote(), Amount.from(100));
    const authorized = await f.transactions.authorize({
      operationId: operation.id,
      ...(await f.remote.prepareRequest(operation)),
    });
    const keyset = f.wallet.getKeyset(f.keysetId);
    f.wallet.loadMintFromCache(f.wallet.getMintInfo(), {
      mintUrl: f.mintUrl,
      keysets: [{ ...keyset.toMintKeyset(), active: false, keys: keyset.keys }],
    });
    const receipts = await f.remote.issue(operation, authorized.recovery!);
    expect((await f.transactions.applyEvidence(operation.id, receipts)).operation.state).toBe(
      'finalized',
    );
  });
});

describe('Mint output ownership', () => {
  it('does not allow a caller to mutate durable outputs through an operation read', async () => {
    const f = await mintFixture();
    const operation = await f.service.prepare(await f.quote(), Amount.from(100));
    const read = await f.service.getOperation(operation.id);
    if (!read || read.state !== 'pending') throw new Error('Expected pending');
    read.outputData.keep[0]!.blindedMessage.B_ = 'mutated';
    expect((await f.service.execute(operation.id)).state).toBe('finalized');
  });
  it('returns the same settled operation to concurrent local execute callers', async () => {
    const f = await mintFixture();
    const operation = await f.service.prepare(await f.quote(), Amount.from(100));
    const results = await Promise.all([
      f.service.execute(operation.id),
      f.service.execute(operation.id),
    ]);
    expect(results.map((r) => r.state)).toEqual(['finalized', 'finalized']);
    expect(f.calls.filter((c) => c.path === '/v1/mint/bolt11')).toHaveLength(1);
  });
});

it('rechecks held receipts even when other outputs of the finalized operation are already stored', async () => {
  const f = await mintFixture();
  f.control.issue = 'lost';
  f.control.proofStates = ['UNSPENT', 'PENDING', 'UNSPENT'];
  const operation = await f.service.prepare(await f.quote(), Amount.from(100));
  expect((await f.service.execute(operation.id)).state).toBe('finalized');
  expect(
    Amount.sum(
      (await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).map((p) => p.amount),
    ).lessThan(100),
  ).toBe(true);
  f.control.proofStates = undefined;
  await f.restart().recoverPendingOperations();
  expect(
    Amount.sum(
      (await f.repositories.proofRepository.getReadyProofs(f.mintUrl)).map((p) => p.amount),
    ).toString(),
  ).toBe('100');
});
