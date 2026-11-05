import { Amount } from '@cashu/cashu-ts';
import type {
  MeltOperation,
  MintOperation,
  MintSwapHistoryEntry,
  MintSwapOperationState,
  Repositories,
} from '@cashu/coco-core/adapter';
import type { ContractRunner, TransactionFactory } from './index.ts';
import { createMintSwapFixtures } from './mintSwap.ts';

export type HistoryProjectionContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
};

const STATES: MintSwapOperationState[] = [
  'preparing',
  'prepared',
  'source_pending',
  'destination_funded',
  'destination_pending',
  'completed',
  'cancelled',
  'failed',
  'needs_attention',
];

/** Verify grouped Mint Swap list visibility and direct-lookup behavior for a supplied adapter. */
export function runHistoryProjectionContract(
  options: HistoryProjectionContractOptions,
  runner: ContractRunner,
): void {
  const { describe, it, expect } = runner;

  describe('Mint Swap history projection contract', () => {
    it('projects every parent state with bounded public data and explicit provenance', () =>
      withRepositories(options, async (repositories) => {
        for (const [ordinal, state] of STATES.entries()) {
          const parent = createMintSwapFixtures(`${ordinal}-${state}`, 1_700_000_000_000 + ordinal)[
            state
          ];
          await repositories.mintSwap.operationRepository.create(parent);
        }

        const entries = await repositories.historyRepository.getPaginatedHistoryEntries(20, 0);
        expect(entries).toHaveLength(STATES.length);
        for (const entry of entries) {
          expect(entry.type).toBe('mint-swap');
          if (entry.type !== 'mint-swap') throw new Error('Expected grouped Mint Swap history');
          const stopped =
            entry.state === 'cancelled' ||
            entry.state === 'failed' ||
            entry.state === 'needs_attention';
          expect(entry.progress.provenance).toBe(stopped ? 'last_safe' : 'current');
          expect(entry.mintUrl).toBe(entry.destinationMintUrl);
          expect(entry.amount.toString()).toBe(entry.destinationAmount.toString());
          expect(entry.unit).toBe('sat');
          for (const forbidden of [
            'sourceQuote',
            'destinationQuote',
            'paymentRequestHash',
            'retry',
            'outputData',
            'proofs',
            'token',
            'error',
          ]) {
            expect(forbidden in entry).toBe(false);
          }
        }
      }));

    it('suppresses only exact linked children from lists and preserves all direct lookups', () =>
      withRepositories(options, async (repositories) => {
        const parent = createMintSwapFixtures('linked').prepared;
        const source = sourceChild(parent.sourceOperationId, parent.createdAt + 2_000);
        const destination = destinationChild(
          parent.destinationOperationId,
          parent.createdAt + 3_000,
        );
        const unrelatedSource = sourceChild('unrelated-source', parent.createdAt + 4_000);
        const unrelatedDestination = destinationChild(
          'unrelated-destination',
          parent.createdAt + 5_000,
        );
        await repositories.mintSwap.operationRepository.create(parent);
        await repositories.meltOperationRepository.create(source);
        await repositories.mintOperationRepository.create(destination);
        await repositories.meltOperationRepository.create(unrelatedSource);
        await repositories.mintOperationRepository.create(unrelatedDestination);

        const entries = await repositories.historyRepository.getPaginatedHistoryEntries(10, 0);
        expect(JSON.stringify(entries.map((entry) => entry.id))).toBe(
          JSON.stringify([
            `mint:${unrelatedDestination.id}`,
            `melt:${unrelatedSource.id}`,
            `mint-swap:${parent.id}`,
          ]),
        );
        const grouped = requireMintSwap(
          await repositories.historyRepository.getHistoryEntryById(`mint-swap:${parent.id}`),
        );
        expect(grouped.updatedAt).toBe(destination.updatedAt);
        expect(grouped.sourceChild.present).toBe(true);
        expect(grouped.destinationChild.present).toBe(true);
        expect(
          (await repositories.historyRepository.getHistoryEntryById(`melt:${source.id}`))?.id,
        ).toBe(`melt:${source.id}`);
        expect(
          (await repositories.historyRepository.getHistoryEntryById(`mint:${destination.id}`))?.id,
        ).toBe(`mint:${destination.id}`);
      }));

    it('keeps missing children explicit and incorporates children created later', () =>
      withRepositories(options, async (repositories) => {
        const parent = createMintSwapFixtures('late').needs_attention;
        await repositories.mintSwap.operationRepository.create(parent);

        const missing = requireMintSwap(
          await repositories.historyRepository.getHistoryEntryById(`mint-swap:${parent.id}`),
        );
        expect(missing.sourceChild.present).toBe(false);
        expect(missing.destinationChild.present).toBe(false);
        expect(missing.progress.provenance).toBe('last_safe');

        const destination = destinationChild(
          parent.destinationOperationId,
          parent.updatedAt + 1_000,
        );
        await repositories.mintOperationRepository.create(destination);
        const late = requireMintSwap(
          await repositories.historyRepository.getHistoryEntryById(`mint-swap:${parent.id}`),
        );
        expect(late.state).toBe('needs_attention');
        expect(late.destinationChild.present).toBe(true);
        expect(late.updatedAt).toBe(destination.updatedAt);
      }));

    it('groups before applying deterministic pagination', () =>
      withRepositories(options, async (repositories) => {
        const expected: string[] = [];
        for (let ordinal = 0; ordinal < 12; ordinal++) {
          const parent = createMintSwapFixtures(
            `page-${ordinal.toString().padStart(2, '0')}`,
            1_700_000_100_000 + ordinal,
          ).prepared;
          await repositories.mintSwap.operationRepository.create(parent);
          await repositories.meltOperationRepository.create(
            sourceChild(parent.sourceOperationId, parent.createdAt + 100),
          );
          await repositories.mintOperationRepository.create(
            destinationChild(parent.destinationOperationId, parent.createdAt + 200),
          );
          expected.unshift(`mint-swap:${parent.id}`);
        }

        const first = await repositories.historyRepository.getPaginatedHistoryEntries(5, 0);
        const second = await repositories.historyRepository.getPaginatedHistoryEntries(5, 5);
        const third = await repositories.historyRepository.getPaginatedHistoryEntries(5, 10);
        expect(JSON.stringify([...first, ...second, ...third].map((entry) => entry.id))).toBe(
          JSON.stringify(expected),
        );
      }));

    it('continues past an arbitrary run of newer hidden children', () =>
      withRepositories(options, async (repositories) => {
        const parentCreatedAt = 1_700_000_200_000;
        for (let ordinal = 0; ordinal < 55; ordinal++) {
          const parent = createMintSwapFixtures(
            `hidden-${ordinal.toString().padStart(2, '0')}`,
            parentCreatedAt + ordinal,
          ).prepared;
          await repositories.mintSwap.operationRepository.create(parent);
          await repositories.mintOperationRepository.create(
            destinationChild(parent.destinationOperationId, 1_700_000_400_000 + ordinal * 1_000),
          );
        }
        const visible = destinationChild('visible-behind-hidden', 1_700_000_300_000);
        await repositories.mintOperationRepository.create(visible);

        const entries = await repositories.historyRepository.getPaginatedHistoryEntries(2, 0);
        expect(entries[0]?.id).toBe(`mint:${visible.id}`);
        expect(entries[1]?.id).toBe('mint-swap:hidden-54');
      }));

    it('uses descending stable IDs to break created-time ties across pages', () =>
      withRepositories(options, async (repositories) => {
        const createdAt = 1_700_000_500_000;
        for (const id of ['tie-a', 'tie-c', 'tie-B']) {
          await repositories.mintSwap.operationRepository.create(
            createMintSwapFixtures(id, createdAt).prepared,
          );
        }

        const first = await repositories.historyRepository.getPaginatedHistoryEntries(2, 0);
        const second = await repositories.historyRepository.getPaginatedHistoryEntries(2, 2);
        expect(JSON.stringify([...first, ...second].map((entry) => entry.id))).toBe(
          JSON.stringify(['mint-swap:tie-c', 'mint-swap:tie-a', 'mint-swap:tie-B']),
        );
      }));
  });
}

async function withRepositories(
  options: HistoryProjectionContractOptions,
  run: (repositories: Repositories) => Promise<void>,
): Promise<void> {
  const { repositories, dispose } = await options.createRepositories();
  try {
    await run(repositories);
  } finally {
    await dispose();
  }
}

function requireMintSwap(
  entry: Awaited<ReturnType<Repositories['historyRepository']['getHistoryEntryById']>>,
): MintSwapHistoryEntry {
  if (!entry || entry.type !== 'mint-swap') throw new Error('Expected Mint Swap history entry');
  return entry;
}

function sourceChild(id: string, updatedAt: number): MeltOperation {
  return {
    id,
    state: 'prepared',
    mintUrl: 'https://source.example',
    method: 'bolt11',
    methodData: { invoice: `lnbc-${id}` },
    unit: 'sat',
    amount: Amount.from(100),
    needsSwap: false,
    fee_reserve: Amount.from(10),
    quoteId: `quote-${id}`,
    swap_fee: Amount.zero(),
    inputAmount: Amount.from(110),
    inputProofSecrets: [`secret-${id}`],
    changeOutputData: { keep: [], send: [] },
    createdAt: updatedAt - 1,
    updatedAt,
  };
}

function destinationChild(id: string, updatedAt: number): MintOperation {
  return {
    id,
    state: 'pending',
    mintUrl: 'https://destination.example',
    method: 'bolt11',
    methodData: {},
    amount: Amount.from(100),
    unit: 'sat',
    quoteId: `quote-${id}`,
    request: `lnbc-${id}`,
    expiry: null,
    outputData: { keep: [], send: [] },
    createdAt: updatedAt - 1,
    updatedAt,
  };
}
