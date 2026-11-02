import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import { createBatchMintFixtures } from '@cashu/coco-adapter-tests';
import type {
  BatchMintMember,
  BatchMintOperation,
} from '../../operations/batchMint/BatchMintOperation.ts';
import {
  assertBatchMintOperation,
  assertBatchMintUpdate,
} from '../../operations/batchMint/BatchMintValidation.ts';

describe('Batch Mint persistence validation', () => {
  const { executing, finalized, failed } = createBatchMintFixtures();
  const [first, second, third] = executing.members as [
    BatchMintMember,
    BatchMintMember,
    BatchMintMember,
  ];

  const invalidMembers: Array<[string, BatchMintMember[]]> = [
    ['no members', []],
    ['a duplicate ordinal', [first, { ...second, ordinal: first.ordinal }, third]],
    ['a negative ordinal', [first, { ...second, ordinal: -1 }, third]],
    ['a duplicate quote', [first, { ...second, quoteId: first.quoteId }, third]],
    ['a zero amount', [first, { ...second, amount: Amount.zero() }, third]],
  ];
  for (const [name, members] of invalidMembers) {
    it(`rejects an operation with ${name}`, () => {
      expect(() => assertBatchMintOperation({ ...executing, members })).toThrow();
    });
  }

  const requestChanges: Array<[string, Partial<BatchMintOperation>]> = [
    ['a member amount', { members: [{ ...first, amount: Amount.from(15) }, second, third] }],
    [
      'a member quote key',
      { members: [{ ...first, pubkey: `02${'cc'.repeat(32)}` }, second, third] },
    ],
    ['the membership', { members: [second, third] }],
    ['the outputs', { outputData: { keep: finalized.outputData.keep.slice(1), send: [] } }],
    ['the mint', { mintUrl: 'https://other.example' }],
    ['the method', { method: 'bolt12' }],
    ['the unit', { unit: 'usd' }],
    ['the creation time', { createdAt: executing.createdAt + 1 }],
  ];
  for (const [name, change] of requestChanges) {
    it(`keeps ${name} immutable`, () => {
      expect(() =>
        assertBatchMintUpdate(executing, { ...finalized, ...change } as BatchMintOperation),
      ).toThrow();
    });
  }

  it('moves only an executing operation to another state', () => {
    expect(() => assertBatchMintUpdate(executing, finalized)).not.toThrow();
    expect(() => assertBatchMintUpdate(finalized, failed)).toThrow();
    expect(() => assertBatchMintUpdate(finalized, executing)).toThrow();
  });
});
