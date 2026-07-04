import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import { QuoteIdentityConflictError } from '../../models/Error';
import type { MeltQuote } from '../../models/MeltQuote';
import type { MintQuote } from '../../models/MintQuote';
import { MemoryMeltQuoteRepository } from '../../repositories/memory/MemoryMeltQuoteRepository';
import { MemoryMintQuoteRepository } from '../../repositories/memory/MemoryMintQuoteRepository';

function makeMintQuote(overrides: Partial<MintQuote<'bolt11'>> = {}): MintQuote<'bolt11'> {
  const quoteId = overrides.quoteId ?? 'mint-quote';
  return {
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    quoteId,
    quote: quoteId,
    request: 'lnbc1mint',
    amount: Amount.from(1),
    unit: 'sat',
    expiry: 1_730_000_000,
    state: 'UNPAID',
    reusable: false,
    amountPaid: Amount.zero(),
    amountIssued: Amount.zero(),
    remoteUpdatedAt: null,
    quoteData: { amount: Amount.from(1) },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeMeltQuote(overrides: Partial<MeltQuote<'bolt11'>> = {}): MeltQuote<'bolt11'> {
  const quoteId = overrides.quoteId ?? 'melt-quote';
  return {
    mintUrl: 'https://mint.test',
    method: 'bolt11',
    quoteId,
    quote: quoteId,
    request: 'lnbc1melt',
    amount: Amount.from(1),
    unit: 'sat',
    fee_reserve: Amount.from(1),
    expiry: 1_730_000_000,
    state: 'UNPAID',
    lastObservedRemoteState: 'UNPAID',
    lastObservedRemoteStateAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('memory quote repositories', () => {
  it('looks up mint quotes by canonical identity and returns null when absent', async () => {
    const repository = new MemoryMintQuoteRepository();
    await repository.upsertMintQuote(
      makeMintQuote({ mintUrl: 'https://mint.test/', quoteId: 'identity-quote' }),
    );

    const stored = await repository.getMintQuoteById({
      mintUrl: 'https://mint.test',
      quoteId: 'identity-quote',
    });
    const absent = await repository.getMintQuoteById({
      mintUrl: 'https://mint.test',
      quoteId: 'missing',
    });

    expect(stored?.method).toBe('bolt11');
    expect(stored?.quoteId).toBe('identity-quote');
    expect(absent).toBe(null);
  });

  it('rejects same-mint mint quote identity collisions across methods', async () => {
    const repository = new MemoryMintQuoteRepository();
    await repository.upsertMintQuote(makeMintQuote({ quoteId: 'collision' }));

    const collidingQuote: MintQuote<'bolt12'> = {
      mintUrl: 'https://mint.test',
      method: 'bolt12',
      quoteId: 'collision',
      quote: 'collision',
      request: 'lno1collision',
      unit: 'sat',
      expiry: 1_730_000_000,
      reusable: true,
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
      remoteUpdatedAt: null,
      quoteData: {
        pubkey: '02'.padEnd(66, '4'),
        amountPaid: Amount.from(0),
        amountIssued: Amount.from(0),
      },
      createdAt: 0,
      updatedAt: 0,
    };

    await expect(repository.upsertMintQuote(collidingQuote)).rejects.toThrow(
      QuoteIdentityConflictError,
    );
    await expect(repository.getMintQuote('https://mint.test', 'bolt12', 'collision')).resolves.toBe(
      null,
    );
  });

  it('looks up melt quotes by canonical identity and rejects method collisions', async () => {
    const repository = new MemoryMeltQuoteRepository();
    await repository.upsertMeltQuote(makeMeltQuote({ quoteId: 'identity-melt' }));

    const stored = await repository.getMeltQuoteById({
      mintUrl: 'https://mint.test',
      quoteId: 'identity-melt',
    });
    const collidingQuote = {
      ...makeMeltQuote({ quoteId: 'identity-melt', request: 'lno1collision' }),
      method: 'bolt12' as const,
    } satisfies MeltQuote<'bolt12'>;

    expect(stored?.method).toBe('bolt11');
    await expect(repository.upsertMeltQuote(collidingQuote)).rejects.toThrow(
      QuoteIdentityConflictError,
    );
  });

  it('keeps mint and melt quote identity namespaces separate', async () => {
    const mintRepository = new MemoryMintQuoteRepository();
    const meltRepository = new MemoryMeltQuoteRepository();

    await mintRepository.upsertMintQuote(makeMintQuote({ quoteId: 'shared' }));
    await meltRepository.upsertMeltQuote(makeMeltQuote({ quoteId: 'shared' }));

    expect(
      (await mintRepository.getMintQuoteById({ mintUrl: 'https://mint.test', quoteId: 'shared' }))
        ?.quoteId,
    ).toBe('shared');
    expect(
      (await meltRepository.getMeltQuoteById({ mintUrl: 'https://mint.test', quoteId: 'shared' }))
        ?.quoteId,
    ).toBe('shared');
  });
});
