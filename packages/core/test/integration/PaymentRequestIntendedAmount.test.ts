import { Amount, PaymentRequest } from '@cashu/cashu-ts';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  initializeCoco,
  MemoryRepositories,
  PaymentRequestError,
  UnitMismatchError,
  type Manager,
} from '../../index.ts';

const mintUrl = process.env.MINT_URL ?? 'http://localhost:3338';
const unit = process.env.CUSTOM_UNIT ?? 'sat';
const sessions: Manager[] = [];

async function session() {
  const repo = new MemoryRepositories();
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => seed,
    watchers: {
      mintOperationWatcher: { disabled: true },
      proofStateWatcher: { disabled: true },
      meltQuoteWatcher: { disabled: true },
    },
    processors: {
      mintOperationProcessor: { disabled: true },
      meltSettlementProcessor: { disabled: true },
      mintSwapOperationProcessor: { disabled: true },
    },
    requestRateLimit: { disabled: true },
  });
  sessions.push(coco);
  return { coco, repo };
}

/** Trusts the real mint and mints `amount` through a paid bolt11 Quote. Returns the Mint Operation ID. */
async function fund(coco: Manager, amount: number): Promise<string> {
  await coco.mint.addMint(mintUrl, { trusted: true });
  const quote = await coco.quotes.mint.create({
    mintUrl,
    method: 'bolt11',
    amount: { amount, unit },
  });
  const mint = await coco.ops.mint.prepare({
    quote: { mintUrl, method: 'bolt11', quoteId: quote.quoteId },
    amount,
  });
  let minted = await coco.ops.mint.execute(mint.id);
  for (let attempt = 0; minted.state !== 'finalized' && attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    minted = await coco.ops.mint.refresh(mint.id);
    if (minted.state === 'pending') minted = await coco.ops.mint.execute(mint.id);
  }
  expect(minted.state).toBe('finalized');
  return mint.id;
}

afterEach(async () => {
  for (const coco of sessions.splice(0)) await coco.dispose();
});

// Core-only public parse contract coverage: no adapter schema or repository contract changes.
// The case drives the real Manager, services and repositories against the real mint.
describe('Payment Request intended amount', () => {
  it('filters an amountless request by its intended amount and pays the receiver net target', async () => {
    const { coco: payer } = await session();
    const { coco: receiver } = await session();
    await fund(payer, 64);

    const encoded = new PaymentRequest([], 'amountless', undefined, unit, [
      mintUrl,
    ]).toEncodedRequest();
    expect((await payer.paymentRequests.parse(encoded)).payableMints).toEqual([mintUrl]);
    expect((await payer.paymentRequests.parse(encoded, { amount: 65 })).payableMints).toEqual([]);
    const parsed = await payer.paymentRequests.parse(encoded, { amount: 32 });
    expect(parsed.payableMints).toEqual([mintUrl]);
    expect(parsed.amount).toBeUndefined();
    expect(parsed.paymentRequest.amount).toBeUndefined();
    expect(parsed.unit).toBe(unit);
    await expect(
      payer.paymentRequests.parse(encoded, { amount: { amount: 32, unit: 'other' } }),
    ).rejects.toBeInstanceOf(UnitMismatchError);
    const fixed = new PaymentRequest([], 'fixed', 32, unit, [mintUrl]).toEncodedRequest();
    await expect(payer.paymentRequests.parse(fixed, { amount: 31 })).rejects.toBeInstanceOf(
      PaymentRequestError,
    );

    const prepared = await payer.paymentRequests.prepare(parsed, { mintUrl, amount: 32 });
    const paid = await payer.paymentRequests.execute(prepared);
    expect(paid.type).toBe('inband');
    if (paid.type !== 'inband') throw new Error('Expected in-band payment');
    await receiver.mint.addMint(mintUrl, { trusted: true });
    const received = await receiver.ops.receive.prepare({ token: paid.token });
    await receiver.ops.receive.execute(received.id);
    expect((await receiver.wallet.balances.byUnit())[unit]?.spendable).toEqual(Amount.from(32));
  }, 30000);
});
