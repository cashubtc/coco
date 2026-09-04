import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MeltBolt11Handler } from '../../infra/handlers/melt/MeltBolt11Handler';
import { MeltBolt12Handler } from '../../infra/handlers/melt/MeltBolt12Handler';
import type { MeltMethodHandler } from '../../operations/melt/MeltMethodHandler';
import {
  createQuoteMeltTestDeps,
  makeQuoteMeltCoreProof,
  QUOTE_MELT_FIXTURE as f,
} from '../fixtures/QuoteMeltHandlerHarness';

type Fixture = ReturnType<typeof createQuoteMeltTestDeps>;

const methods = [
  {
    label: 'BOLT11',
    method: 'bolt11',
    requestKey: 'invoice',
    request: f.invoice,
    fee: 10,
    preimage: 'preimage-123',
    handler: () => new MeltBolt11Handler(),
    create: (fixture: Fixture) => fixture.mocks.createMeltQuoteBolt11,
    fetch: (fixture: Fixture) => fixture.mocks.checkMeltQuote,
    state: (fixture: Fixture) => fixture.mocks.checkMeltQuoteState,
    melt: (fixture: Fixture) => fixture.mocks.customMeltBolt11,
  },
  {
    label: 'BOLT12',
    method: 'bolt12',
    requestKey: 'offer',
    request: f.offer,
    fee: 12,
    preimage: 'preimage-12',
    handler: () => new MeltBolt12Handler(),
    create: (fixture: Fixture) => fixture.mocks.createMeltQuoteBolt12,
    fetch: (fixture: Fixture) => fixture.mocks.checkMeltQuoteBolt12,
    state: (fixture: Fixture) => fixture.mocks.checkMeltQuoteBolt12State,
    melt: (fixture: Fixture) => fixture.mocks.customMeltBolt12,
  },
] as const;

for (const config of methods) {
  describe(`${config.label} melt adapter contract`, () => {
    let handler: MeltMethodHandler<any>;
    let fixture: Fixture;
    const input = makeQuoteMeltCoreProof('input-1', 100 + config.fee);
    const methodData = { [config.requestKey]: config.request };
    const initOperation = () => ({
      id: `operation-${config.method}`,
      state: 'init' as const,
      mintUrl: f.mintUrl,
      unit: 'sat',
      method: config.method,
      methodData,
      createdAt: 0,
      updatedAt: 0,
    });
    const executingOperation = () => ({
      ...initOperation(),
      state: 'executing' as const,
      quoteId: f.quoteId,
      amount: Amount.from(100),
      fee_reserve: Amount.from(config.fee),
      swap_fee: Amount.zero(),
      needsSwap: false,
      inputAmount: Amount.from(100 + config.fee),
      inputProofSecrets: ['input-1'],
      changeOutputData: { keep: [], send: [] },
    });

    beforeEach(() => {
      handler = config.handler();
      fixture = createQuoteMeltTestDeps();
      fixture.mocks.getProofsByOperationId.mockResolvedValue([input]);
      fixture.mocks.selectProofsToSend.mockResolvedValue([input]);
    });

    it.each([
      [undefined, undefined],
      [1_000, 1_000_000],
    ])('converts optional quote amount %p sats to %p millisats', async (sats, msats) => {
      const quote = await handler.createQuote({
        ...fixture.deps,
        mintUrl: f.mintUrl,
        methodData: { ...methodData, amountSats: sats && Amount.from(sats) },
        unit: 'sat',
        wallet: fixture.wallet,
      });

      expect(config.create(fixture)).toHaveBeenCalledWith(
        config.request,
        msats && Amount.from(msats),
      );
      expect(quote).toMatchObject({ method: config.method, quoteId: f.quoteId });
    });

    it('fetches through its full-quote endpoint', async () => {
      const quote = await handler.fetchRemoteQuote({
        ...fixture.deps,
        quote: { mintUrl: f.mintUrl, quoteId: f.quoteId },
      } as never);

      expect(config.fetch(fixture)).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
      expect(quote.method).toBe(config.method);
    });

    it('uses its fee reserve during preparation', async () => {
      const prepared = await handler.prepare({
        ...fixture.deps,
        operation: initOperation() as never,
        quote: fixture.boltQuote(config.request, config.fee),
        wallet: fixture.wallet,
      });

      expect(prepared.fee_reserve).toEqual(Amount.from(config.fee));
      expect(fixture.mocks.selectProofsToSend).toHaveBeenCalledWith(
        f.mintUrl,
        { amount: Amount.from(100 + config.fee), unit: 'sat' },
        true,
      );
    });

    it('uses its custom melt endpoint and maps the preimage', async () => {
      const result = await handler.execute({
        ...fixture.deps,
        operation: executingOperation() as never,
        wallet: fixture.wallet,
        reservedProofs: [input],
      });

      expect(config.melt(fixture)).toHaveBeenCalledWith(f.mintUrl, [input], [], f.quoteId);
      if (result.status !== 'PAID') throw new Error('Expected paid result');
      expect(result.finalized.finalizedData).toEqual({ preimage: config.preimage });
    });

    it('uses its state-only endpoint for pending checks', async () => {
      await expect(
        handler.checkPending?.({
          ...fixture.deps,
          operation: { ...executingOperation(), state: 'pending' } as never,
          wallet: fixture.wallet,
        }),
      ).resolves.toBe('finalize');
      expect(config.state(fixture)).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
    });

    it('uses its full-quote endpoint when finalizing', async () => {
      const result = await handler.finalize?.({
        ...fixture.deps,
        operation: { ...executingOperation(), state: 'pending' } as never,
      });

      expect(config.fetch(fixture)).toHaveBeenCalledWith(f.mintUrl, f.quoteId);
      expect(result?.finalizedData).toEqual({ preimage: config.preimage });
    });
  });
}
