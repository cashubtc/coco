/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
// @ts-ignore bun:sqlite types are provided by the runtime in this workspace.
import { Database } from 'bun:sqlite';
import { Amount } from '@cashu/coco-core';
import { SqliteRepositories } from '../index.ts';

describe('SqliteMintOperationRepository', () => {
  const quoteExpiry = 1_730_000_000;
  let database: Database;
  let repositories: SqliteRepositories;

  beforeEach(async () => {
    database = new Database(':memory:');
    repositories = new SqliteRepositories({ database });
    await repositories.init();
  });

  afterEach(async () => {
    await repositories.db.close();
  });

  it('persists and loads supported mint operation states', async () => {
    await repositories.mintOperationRepository.create({
      id: 'mint-op-init',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-init',
      state: 'init',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
    });

    await repositories.mintOperationRepository.create({
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
      outputData: { keep: [], send: [] },
    });

    await repositories.mintOperationRepository.create({
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
      outputData: { keep: [], send: [] },
    });

    await repositories.mintOperationRepository.create({
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
      terminalFailure: {
        reason: 'quote expired',
        observedAt: 9000,
      },
      outputData: { keep: [], send: [] },
    });

    expect(await repositories.mintOperationRepository.getById('mint-op-init')).toEqual({
      id: 'mint-op-init',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-init',
      state: 'init',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
    });

    expect(await repositories.mintOperationRepository.getById('mint-op-pending')).toEqual({
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
      pubkey: undefined,
      outputData: { keep: [], send: [] },
    });

    expect(await repositories.mintOperationRepository.getById('mint-op-finalized')).toEqual({
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
      pubkey: undefined,
      outputData: { keep: [], send: [] },
    });

    expect(await repositories.mintOperationRepository.getById('mint-op-failed')).toEqual({
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
      pubkey: undefined,
      terminalFailure: {
        reason: 'quote expired',
        observedAt: 9000,
      },
      outputData: { keep: [], send: [] },
    });
  });
});
