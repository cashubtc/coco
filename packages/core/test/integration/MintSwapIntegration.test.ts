// Mint Swap against two real mints. scripts/test-integration.sh starts the second mint for core and
// exposes it as MINT_URL_2.
//
// Core-only on purpose: the shared Mint Swap suites in adapter-tests already cover persistence on
// every storage adapter with deterministic protocol doubles. What only real mints add is the protocol
// boundary, so running this once on Memory repositories avoids two mints in every adapter job.
// Failures a real mint cannot produce on demand stay with those doubles.
import { Amount } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';

const sourceMintUrl = process.env.MINT_URL;
const destinationMintUrl = process.env.MINT_URL_2;

if (!sourceMintUrl || !destinationMintUrl) {
  throw new Error('MINT_URL and MINT_URL_2 must both be set');
}

const sessions: Manager[] = [];

async function session() {
  const repo = new MemoryRepositories();
  await repo.init();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    requestRateLimit: { disabled: true },
  });
  sessions.push(coco);
  return coco;
}

async function fund(coco: Manager, mintUrl: string, amount: Amount) {
  await coco.mint.addMint(mintUrl, { trusted: true });
  const quote = await coco.quotes.mint.create({
    mintUrl,
    amount: { amount, unit: 'sat' },
    method: 'bolt11',
  });
  const operation = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount,
  });
  let result = await coco.ops.mint.execute(operation.id);
  for (let attempt = 0; result.state !== 'finalized' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await coco.ops.mint.refresh(operation.id);
    if (result.state === 'pending') result = await coco.ops.mint.execute(operation.id);
  }
  expect(result.state).toBe('finalized');
}

async function balance(coco: Manager, mintUrl: string) {
  return (await coco.wallet.balances.total({ mintUrls: [mintUrl] })).total;
}

afterEach(async () => {
  for (const coco of sessions.splice(0)) await coco.dispose();
});

describe('Mint Swap with two real mints', () => {
  // Mint Swap is BOLT11/sat only; the custom-unit run would repeat the sat run.
  it.skipIf(!!process.env.CUSTOM_UNIT)(
    'moves an exact amount to the destination mint and debits the source within its bounds',
    async () => {
      const coco = await session();
      await fund(coco, sourceMintUrl, Amount.from(64));
      await coco.mint.addMint(destinationMintUrl, { trusted: true });
      const sourceBefore = await balance(coco, sourceMintUrl);
      const destinationAmount = Amount.from(32);

      const prepared = await coco.ops.mintSwap.prepare({
        id: `mint-swap-${crypto.randomUUID()}`,
        sourceMintUrl,
        destinationMintUrl,
        destinationAmount: { amount: destinationAmount, unit: 'sat' },
      });
      expect(prepared.state).toBe('prepared');
      if (prepared.state !== 'prepared') return;
      const bounds = prepared.sourceDebitBounds;
      expect(await balance(coco, sourceMintUrl)).toEqual(sourceBefore);

      const states: string[] = [];
      const off = coco.on('mint-swap:updated', ({ operationId, state }) => {
        if (operationId === prepared.id) states.push(state);
      });
      await coco.ops.mintSwap.execute(prepared.id);
      const outcome = await coco.ops.mintSwap.waitForOutcome(prepared.id, { timeoutMs: 30_000 });
      off();

      // On failure this prints the whole operation, including retry and attention details.
      expect(outcome).toMatchObject({ status: 'completed' });
      if (outcome.status !== 'completed') return;
      const { sourceSettlement, destinationCompletion } = outcome.operation;
      expect(states.at(-1)).toBe('completed');

      // Destination: exactly the requested amount was issued, stored and counted.
      expect(destinationCompletion.quoteAmountIssued).toEqual(destinationAmount);
      expect(destinationCompletion.storedProofAmount).toEqual(destinationAmount);
      expect(await balance(coco, destinationMintUrl)).toEqual(destinationAmount);

      // Source: final debit = destination amount + total fee, within the prepared bounds.
      const debit = sourceBefore.subtract(await balance(coco, sourceMintUrl));
      expect(debit).toEqual(sourceSettlement.finalDebit);
      expect(debit).toEqual(destinationAmount.add(sourceSettlement.totalFee));
      expect(debit.greaterThanOrEqual(bounds.minimum)).toBe(true);
      expect(debit.lessThanOrEqual(bounds.maximum)).toBe(true);

      // Children finished. Lists expose the parent action, while exact child drill-down remains
      // available by deterministic history ID.
      expect((await coco.ops.melt.get(outcome.operation.sourceOperationId))?.state).toBe(
        'finalized',
      );
      expect((await coco.ops.mint.get(outcome.operation.destinationOperationId))?.state).toBe(
        'finalized',
      );
      const history = await coco.history.getPaginatedHistory();
      const parentHistoryId = `mint-swap:${outcome.operation.id}`;
      const sourceHistoryId = `melt:${outcome.operation.sourceOperationId}`;
      const destinationHistoryId = `mint:${outcome.operation.destinationOperationId}`;
      expect(history.filter((entry) => entry.id === parentHistoryId)).toEqual([
        expect.objectContaining({
          type: 'mint-swap',
          operationId: outcome.operation.id,
          state: 'completed',
          sourceMintUrl: outcome.operation.sourceMintUrl,
          destinationMintUrl: outcome.operation.destinationMintUrl,
          destinationAmount,
          progress: expect.objectContaining({
            provenance: 'current',
            state: 'completed',
            sourceSettlement,
            destinationCompletion,
          }),
          sourceChild: expect.objectContaining({ present: true, state: 'finalized' }),
          destinationChild: expect.objectContaining({ present: true, state: 'finalized' }),
        }),
      ]);
      expect(history.some((entry) => entry.id === sourceHistoryId)).toBe(false);
      expect(history.some((entry) => entry.id === destinationHistoryId)).toBe(false);
      expect(await coco.history.getHistoryEntryById(parentHistoryId)).toMatchObject({
        type: 'mint-swap',
        operationId: outcome.operation.id,
      });
      expect(await coco.history.getHistoryEntryById(sourceHistoryId)).toMatchObject({
        type: 'melt',
        operationId: outcome.operation.sourceOperationId,
      });
      expect(await coco.history.getHistoryEntryById(destinationHistoryId)).toMatchObject({
        type: 'mint',
        operationId: outcome.operation.destinationOperationId,
      });
    },
    60_000,
  );
});
