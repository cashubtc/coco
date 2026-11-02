import { expect, test } from 'bun:test';

import {
  createMintQuoteRequestSchema,
  createMeltQuoteRequestSchema,
  prepareMeltOperationRequestSchema,
  meltResultSchema,
} from '../../src/v1/resource-schemas.js';

test('quote schemas retain method-specific fields and lossless payment amounts', () => {
  for (const input of [
    { method: 'bolt11', amount: '18446744073709551615', locked: true },
    { method: 'bolt12', description: 'Reusable invoice' },
    { method: 'bolt12', amount: '9007199254740993', unit: 'sat' },
    { method: 'onchain', unit: 'sat' },
  ] as const)
    expect(createMintQuoteRequestSchema.parse(input)).toEqual(input);
  for (const input of [
    { method: 'bolt11', invoice: 'invoice', amountSats: '9007199254740993', unit: 'usd' },
    { method: 'bolt12', offer: 'offer', amountSats: '1' },
    { method: 'onchain', address: 'address', amountSats: '1000' },
  ] as const)
    expect(createMeltQuoteRequestSchema.parse(input)).toEqual(input);
  for (const input of [
    { method: 'bolt11', amount: '1', description: 'bolt12 only' },
    { method: 'bolt12', locked: true },
    { method: 'onchain', amount: '1' },
  ])
    expect(() => createMintQuoteRequestSchema.parse(input)).toThrow();
  expect(() =>
    createMeltQuoteRequestSchema.parse({ method: 'onchain', address: 'address' }),
  ).toThrow();
  expect(() =>
    prepareMeltOperationRequestSchema.parse({
      mintUrl: 'https://mint.example',
      quoteId: 'q',
      feeIndex: 0.5,
    }),
  ).toThrow();
});

test('Melt results contain exactly one nonempty payment proof', () => {
  expect(meltResultSchema.parse({ preimage: 'preimage' })).toEqual({ preimage: 'preimage' });
  expect(meltResultSchema.parse({ outpoint: 'outpoint' })).toEqual({ outpoint: 'outpoint' });
  for (const input of [
    {},
    { preimage: '' },
    { outpoint: '' },
    { preimage: 'p', outpoint: 'o' },
    { preimage: 'p', proofs: [] },
  ]) {
    expect(() => meltResultSchema.parse(input)).toThrow();
  }
});
