import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database, { type Database as BetterSqlite3Database } from 'better-sqlite3';
import { Amount } from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';
import { ensureSchema } from '../schema.ts';
import { SqliteMintOperationRepository } from '../repositories/MintOperationRepository.ts';

describe('SqliteMintOperationRepository', () => {
  const quoteExpiry = 1_730_000_000;
  let database: BetterSqlite3Database;
  let db: SqliteDb;
  let repository: SqliteMintOperationRepository;

  beforeEach(async () => {
    database = new Database(':memory:');
    db = new SqliteDb({ database });
    await ensureSchema(db);
    repository = new SqliteMintOperationRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('persists and loads supported mint operation states', async () => {
    await repository.create({
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

    await repository.create({
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

    await repository.create({
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

    await repository.create({
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
      pubkey: undefined,
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
      pubkey: undefined,
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
      pubkey: undefined,
      terminalFailure: {
        reason: 'quote expired',
        observedAt: 9000,
      },
      outputData: { keep: [], send: [] },
    });
  });

  it('returns only pending and executing work from getPending', async () => {
    await repository.create({
      id: 'mint-op-pending',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-pending',
      state: 'pending',
      createdAt: 1000,
      updatedAt: 2000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
      request: 'lnbc1pending',
      expiry: quoteExpiry,
      outputData: { keep: [], send: [] },
    });

    await repository.create({
      id: 'mint-op-executing',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-executing',
      state: 'executing',
      createdAt: 3000,
      updatedAt: 4000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(200),
      unit: 'sat',
      request: 'lnbc1executing',
      expiry: quoteExpiry + 1,
      outputData: { keep: [], send: [] },
    });

    await repository.create({
      id: 'mint-op-finalized',
      mintUrl: 'https://mint.test',
      quoteId: 'quote-finalized',
      state: 'finalized',
      createdAt: 5000,
      updatedAt: 6000,
      error: undefined,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(300),
      unit: 'sat',
      request: 'lnbc1finalized',
      expiry: quoteExpiry + 2,
      outputData: { keep: [], send: [] },
    });

    const pending = await repository.getPending();

    expect(pending).toHaveLength(2);
    expect(pending.map((operation) => operation.state).sort()).toEqual(['executing', 'pending']);
    expect(pending.map((operation) => operation.id).sort()).toEqual([
      'mint-op-executing',
      'mint-op-pending',
    ]);
  });
});
