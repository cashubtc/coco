import { Amount } from '@cashu/cashu-ts';
import { initializeCoco, type Manager } from '../../Manager.ts';
import type { CoreEvents } from '../../events/types.ts';
import {
  mintQuoteFromBolt11Response,
  mintQuoteFromBolt12Response,
  mintQuoteFromOnchainResponse,
} from '../../models/MintQuote.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import { FakeBatchMint, quoteKey, type FakeMintQuote } from './BatchMintMint.ts';

export const ownedKey = quoteKey(3);
export const foreignKey = quoteKey(4);

type QuoteSpec = Omit<FakeMintQuote, 'request' | 'expiry' | 'amountIssued' | 'unit'> & {
  unit?: string;
  amountIssued?: number;
};

/**
 * A real Manager over Memory repositories, talking HTTP to an in-process fake mint. Watchers and
 * processors are disabled so tests drive every effect explicitly.
 */
export async function createBatchMintHarness(
  options: {
    repo?: MemoryRepositories;
    mint?: FakeBatchMint;
    /** NUT-29 settings the mint advertises when it is added. */
    nut29?: FakeBatchMint['nut29'];
  } = {},
) {
  const mint = options.mint ?? new FakeBatchMint();
  if (!options.mint) mint.install();
  if (options.nut29 !== undefined) mint.nut29 = options.nut29;
  const repo = options.repo ?? new MemoryRepositories();
  const coco = await initializeCoco({
    repo,
    seedGetter: async () => new Uint8Array(64).fill(5),
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
  });
  if (!options.repo) {
    await coco.mint.addMint(mint.mintUrl, { trusted: true });
    await repo.keyRingRepository.setPersistedKeyPair({
      ...ownedKey,
      purpose: 'nut20_mint_quote',
    });
  }
  const events: Array<{ event: keyof CoreEvents; payload: unknown }> = [];
  const record = (event: keyof CoreEvents) =>
    coco.on(event, (payload: unknown) => {
      events.push({ event, payload });
    });
  for (const event of [
    'batch-mint-op:executing',
    'batch-mint-op:finalized',
    'batch-mint-op:failed',
    'mint-op:pending',
    'mint-op:executing',
    'mint-op:finalized',
    'mint-op:failed',
    'history:updated',
  ] as const)
    record(event);

  /** Create the quote at the mint and persist the matching canonical quote locally. */
  const quote = async (spec: QuoteSpec) => {
    const stored = mint.addQuote({ unit: 'sat', ...spec });
    await persist(stored.quote);
    return stored;
  };
  const persist = async (quoteId: string) => {
    const wire = mint.quoteResponse(quoteId) as Record<string, unknown> & { method: string };
    const normalized = {
      ...wire,
      amount: wire.amount == null ? wire.amount : Amount.from(wire.amount as number),
      amount_paid: Amount.from(wire.amount_paid as number),
      amount_issued: Amount.from(wire.amount_issued as number),
    };
    const canonical =
      wire.method === 'bolt11'
        ? mintQuoteFromBolt11Response(mint.mintUrl, normalized as never)
        : wire.method === 'bolt12'
          ? mintQuoteFromBolt12Response(mint.mintUrl, normalized as never)
          : mintQuoteFromOnchainResponse(mint.mintUrl, normalized as never);
    await repo.mintQuoteRepository.upsertMintQuote(canonical);
  };

  return {
    mint,
    repo,
    coco: coco as Manager,
    events,
    quote,
    persist,
    eventNames: () => events.filter((e) => e.event !== 'history:updated').map((e) => e.event),
    async dispose() {
      await coco.dispose();
    },
    uninstall() {
      mint.uninstall();
    },
  };
}

export type BatchMintHarness = Awaited<ReturnType<typeof createBatchMintHarness>>;
