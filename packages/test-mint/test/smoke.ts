#!/usr/bin/env bun

import assert from 'node:assert/strict';

import { initializeCoco, MemoryRepositories, type Manager } from '../../core/index.ts';
import { ExperimentalTestMint } from '../src/index.ts';

async function spendableBalance(manager: Manager, mintUrl: string): Promise<number> {
  const balances = await manager.wallet.balances.byMint({
    mintUrls: [mintUrl],
    units: ['sat'],
  });
  return balances[mintUrl]?.spendable.toNumber() ?? 0;
}

const mint = await ExperimentalTestMint.start();
const repositories = new MemoryRepositories();
const seed = crypto.getRandomValues(new Uint8Array(64));
const manager = await initializeCoco({
  repo: repositories,
  seedGetter: async () => seed,
  watchers: {
    mintOperationWatcher: { disabled: true },
    proofStateWatcher: { disabled: true },
    meltQuoteWatcher: { disabled: true },
  },
  processors: {
    mintOperationProcessor: { disabled: true },
    meltSettlementProcessor: { disabled: true },
  },
});

try {
  await manager.mint.addMint(mint.url, { trusted: true });
  const mintQuote = await manager.quotes.mint.create({
    mintUrl: mint.url,
    method: 'bolt11',
    amount: 100,
    unit: 'sat',
  });
  assert.equal(mintQuote.state, 'UNPAID');

  await mint.payments.settleIncoming({ request: mintQuote.request });
  const paidQuote = await manager.quotes.mint.refresh({
    mintUrl: mint.url,
    quoteId: mintQuote.quoteId,
  });
  assert.equal(paidQuote.state, 'PAID');

  const preparedMint = await manager.ops.mint.prepare({ quote: paidQuote, amount: 100 });
  const finalizedMint = await manager.ops.mint.execute(preparedMint.id);
  assert.equal(finalizedMint.state, 'finalized');
  assert.equal(await spendableBalance(manager, mint.url), 100);

  const invoice = mint.payments.createOutgoingInvoice({ amount: 20 });
  const meltQuote = await manager.quotes.melt.create({
    mintUrl: mint.url,
    method: 'bolt11',
    methodData: { invoice },
    unit: 'sat',
  });
  const preparedMelt = await manager.ops.melt.prepare({ quote: meltQuote });
  const meltExecution = manager.ops.melt.execute(preparedMelt.id);
  const outgoing = await mint.payments.waitForOutgoing({ quoteId: meltQuote.quoteId });
  await mint.payments.succeedOutgoing({ quoteId: outgoing.quoteId });

  const finalizedMelt = await meltExecution;
  assert.equal(finalizedMelt.state, 'finalized');
  assert.equal(finalizedMelt.effectiveFee?.toNumber(), 1);
  assert.equal(await spendableBalance(manager, mint.url), 79);
  console.log('Experimental test mint smoke flow passed: minted 100, melted 20 + 1 fee.');
} finally {
  await manager.dispose();
  await mint.stop();
}
