/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/coco-core';
import { IdbMintOperationRepository } from './MintOperationRepository.ts';
import type { MintOperationRow } from '../lib/db.ts';

describe('IdbMintOperationRepository', () => {
  const quoteExpiry = 1_730_000_000;
  it('loads supported persisted mint operation states', async () => {
    const rows = new Map<string, MintOperationRow>([
      [
        'mint-op-init',
        {
          id: 'mint-op-init',
          mintUrl: 'https://mint.test',
          state: 'init',
          createdAt: 1,
          updatedAt: 2,
          error: null,
          method: 'bolt11',
          methodDataJson: JSON.stringify({}),
          amount: 100,
          unit: 'sat',
          outputDataJson: null,
        },
      ],
      [
        'mint-op-pending',
        {
          id: 'mint-op-pending',
          mintUrl: 'https://mint.test',
          quoteId: 'quote-pending',
          state: 'pending',
          createdAt: 3,
          updatedAt: 4,
          error: null,
          method: 'bolt11',
          methodDataJson: JSON.stringify({}),
          amount: 100,
          unit: 'sat',
          request: 'lnbc1pending',
          expiry: quoteExpiry,
          lastObservedRemoteState: 'PAID',
          lastObservedRemoteStateAt: 5,
          outputDataJson: JSON.stringify({ keep: [], send: [] }),
        },
      ],
      [
        'mint-op-finalized',
        {
          id: 'mint-op-finalized',
          mintUrl: 'https://mint.test',
          quoteId: 'quote-finalized',
          state: 'finalized',
          createdAt: 5,
          updatedAt: 6,
          error: 'already issued',
          method: 'bolt11',
          methodDataJson: JSON.stringify({}),
          amount: 200,
          unit: 'sat',
          request: 'lnbc1finalized',
          expiry: quoteExpiry + 1,
          lastObservedRemoteState: 'ISSUED',
          lastObservedRemoteStateAt: 7,
          outputDataJson: JSON.stringify({ keep: [], send: [] }),
        },
      ],
      [
        'mint-op-failed',
        {
          id: 'mint-op-failed',
          mintUrl: 'https://mint.test',
          quoteId: 'quote-failed',
          state: 'failed',
          createdAt: 7,
          updatedAt: 8,
          error: 'quote expired',
          method: 'bolt11',
          methodDataJson: JSON.stringify({}),
          amount: 300,
          unit: 'sat',
          request: 'lnbc1failed',
          expiry: quoteExpiry + 2,
          lastObservedRemoteState: 'PAID',
          lastObservedRemoteStateAt: 9,
          terminalFailureJson: JSON.stringify({
            reason: 'quote expired',
            observedAt: 10,
          }),
          outputDataJson: JSON.stringify({ keep: [], send: [] }),
        },
      ],
    ]);

    const repository = new IdbMintOperationRepository({
      table: () => ({
        get: async (id: string) => rows.get(id),
      }),
    } as any);

    await expect(repository.getById('mint-op-init')).resolves.toEqual({
      id: 'mint-op-init',
      mintUrl: 'https://mint.test',
      state: 'init',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
    });

    await expect(repository.getById('mint-op-pending')).resolves.toEqual({
      id: 'mint-op-pending',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-pending',
      state: 'pending',
      createdAt: 3000,
      updatedAt: 4000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
      request: 'lnbc1pending',
      expiry: quoteExpiry,
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: 5,
      outputData: { keep: [], send: [] },
    });

    await expect(repository.getById('mint-op-finalized')).resolves.toEqual({
      id: 'mint-op-finalized',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-finalized',
      state: 'finalized',
      createdAt: 5000,
      updatedAt: 6000,
      error: 'already issued',
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(200),
      unit: 'sat',
      request: 'lnbc1finalized',
      expiry: quoteExpiry + 1,
      lastObservedRemoteState: 'ISSUED',
      lastObservedRemoteStateAt: 7,
      outputData: { keep: [], send: [] },
    });

    await expect(repository.getById('mint-op-failed')).resolves.toEqual({
      id: 'mint-op-failed',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-failed',
      state: 'failed',
      createdAt: 7000,
      updatedAt: 8000,
      error: 'quote expired',
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(300),
      unit: 'sat',
      request: 'lnbc1failed',
      expiry: quoteExpiry + 2,
      lastObservedRemoteState: 'PAID',
      lastObservedRemoteStateAt: 9,
      terminalFailure: {
        reason: 'quote expired',
        observedAt: 10,
      },
      outputData: { keep: [], send: [] },
    });
  });

  it('queries only pending and executing states for active work', async () => {
    const requestedStates: string[][] = [];

    const repository = new IdbMintOperationRepository({
      table: () => ({
        where: () => ({
          anyOf: (states: string[]) => {
            requestedStates.push(states);
            return {
              toArray: async () => [] as MintOperationRow[],
            };
          },
        }),
      }),
    } as any);

    await repository.getByState('pending');
    await repository.getPending();

    expect(requestedStates[0]).toEqual(['pending']);
    expect(requestedStates[1]).toEqual(['pending', 'executing']);
  });
});
