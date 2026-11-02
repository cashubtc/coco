import { Amount } from '@cashu/cashu-ts';
import type {
  BatchMintMember,
  BatchMintOperation,
  BatchMintOperationState,
  HistoryEntry,
  Repositories,
  RepositoryTransactionScope,
} from '@cashu/coco-core/adapter';
import type { ContractRunner, TransactionFactory } from './index.ts';

export type BatchMintContractOptions<TRepositories extends Repositories = Repositories> = {
  createRepositories: TransactionFactory<TRepositories>;
};

const CREATED_AT = 1_700_000_000_000;
const MINT_URL = 'https://batch.example';

function output(secret: string, amount: number) {
  return {
    blindedMessage: { amount, id: '00batchkeyset', B_: `B_${secret}` },
    blindingFactor: '01',
    secret: `5ec7e7${secret}`,
  };
}

function member(
  ordinal: number,
  quoteId: string,
  amount: number,
  pubkey: string | null,
): BatchMintMember {
  return {
    ordinal,
    quoteId,
    amount: Amount.from(amount),
    request: `lnbc-${quoteId}`,
    pubkey,
  };
}

/**
 * Batch Mint Operation fixtures in every state. Members are listed out of ordinal order so
 * adapters must hydrate them by ordinal rather than by insertion order.
 */
function fixtures(
  id = 'batch',
  createdAt = CREATED_AT,
): { [S in BatchMintOperationState]: Extract<BatchMintOperation, { state: S }> } {
  const base = {
    id,
    mintUrl: MINT_URL,
    method: 'bolt11' as const,
    unit: 'sat',
    members: [
      member(1, `${id}-quote-b`, 8, null),
      member(0, `${id}-quote-a`, 16, `02${'aa'.repeat(32)}`),
      member(2, `${id}-quote-c`, 4, `02${'bb'.repeat(32)}`),
    ],
    outputData: {
      keep: [output(`${id}-16`, 16), output(`${id}-8`, 8), output(`${id}-4`, 4)],
      send: [],
    },
    createdAt,
  };
  return {
    executing: { ...base, state: 'executing', updatedAt: createdAt },
    finalized: { ...base, state: 'finalized', updatedAt: createdAt + 1_000 },
    failed: {
      ...base,
      state: 'failed',
      updatedAt: createdAt + 1_000,
      error: 'quote already issued',
      terminalFailure: {
        reason: 'quote already issued',
        code: '20002',
        observedAt: createdAt + 1_000,
      },
    },
  };
}

export const createBatchMintFixtures = fixtures;

/** Lossless, key-order independent comparable form; members are compared in ordinal order. */
function comparable(operation: BatchMintOperation | null): string {
  if (!operation) return '';
  return JSON.stringify([
    operation.id,
    operation.mintUrl,
    operation.method,
    operation.unit,
    operation.state,
    operation.createdAt,
    operation.updatedAt,
    operation.error ?? null,
    operation.state === 'failed' ? operation.terminalFailure : null,
    operation.outputData,
    [...operation.members]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((value) => [
        value.ordinal,
        value.quoteId,
        value.amount.toString(),
        value.request,
        value.pubkey,
      ]),
  ]);
}

function ids(operations: BatchMintOperation[]): string {
  return JSON.stringify(operations.map(({ id }) => id));
}

function ordinals(operation: BatchMintOperation | null): string {
  return JSON.stringify(operation?.members.map(({ ordinal }) => ordinal) ?? null);
}

export function runBatchMintPersistenceContract(
  options: BatchMintContractOptions,
  runner: ContractRunner,
): void {
  const { describe, it, expect } = runner;

  describe('Batch Mint persistence contract', () => {
    it('round-trips every state with members hydrated in ordinal order', () =>
      withRepositories(options, async (repositories) => {
        const repository = requireBatchMint(repositories);
        for (const state of ['executing', 'finalized', 'failed'] as const) {
          const operation = fixtures(`round-trip-${state}`)[state];
          await repository.create(operation);
          const stored = await repository.getById(operation.id);
          expect(comparable(stored)).toBe(comparable(operation));
          expect(ordinals(stored)).toBe('[0,1,2]');
          if (stored?.members[0]) stored.members[0].quoteId = 'mutated-read';
          const reread = await repository.getById(operation.id);
          expect(reread?.members[0]?.quoteId).toBe(`round-trip-${state}-quote-a`);
        }
        expect(await repository.getById('missing')).toBe(null);
      }));

    it('rejects duplicate IDs and invalid operations without mutation', () =>
      withRepositories(options, async (repositories) => {
        const repository = requireBatchMint(repositories);
        const existing = fixtures('existing').executing;
        await repository.create(existing);
        const [first, second, third] = fixtures('duplicate').executing.members as [
          BatchMintMember,
          BatchMintMember,
          BatchMintMember,
        ];
        const invalid: BatchMintOperation[] = [
          { ...fixtures('other').executing, id: existing.id },
          {
            ...fixtures('duplicate-quote').executing,
            members: [first, { ...second, quoteId: first.quoteId }, third],
          },
        ];
        for (const operation of invalid) {
          await expectRejects(() => repository.create(operation), expect);
        }
        expect(comparable(await repository.getById(existing.id))).toBe(comparable(existing));
        expect(await repository.getById('duplicate-quote')).toBe(null);
        expect(
          await repository.listByQuote({ mintUrl: MINT_URL, quoteId: first.quoteId }),
        ).toHaveLength(0);
      }));

    it('updates outcomes but keeps the exact request immutable', () =>
      withRepositories(options, async (repositories) => {
        const repository = requireBatchMint(repositories);
        const { executing, finalized, failed } = fixtures('update');
        await repository.create(executing);
        const deferred = { ...executing, updatedAt: CREATED_AT + 500, error: 'timeout' };
        await repository.update(deferred);
        expect(comparable(await repository.getById(executing.id))).toBe(comparable(deferred));

        const [first, ...rest] = executing.members as [BatchMintMember, ...BatchMintMember[]];
        await expectRejects(
          () =>
            repository.update({
              ...finalized,
              members: [{ ...first, amount: Amount.from(15) }, ...rest],
            }),
          expect,
        );
        await expectRejects(() => repository.update({ ...finalized, id: 'missing' }), expect);
        expect(comparable(await repository.getById(executing.id))).toBe(comparable(deferred));

        await repository.update(finalized);
        expect(comparable(await repository.getById(executing.id))).toBe(comparable(finalized));
        await expectRejects(() => repository.update(failed), expect);
        await expectRejects(() => repository.update(executing), expect);
        expect(comparable(await repository.getById(executing.id))).toBe(comparable(finalized));
      }));

    it('lists by state, in flight and Quote Identity in createdAt then ID order', () =>
      withRepositories(options, async (repositories) => {
        const repository = requireBatchMint(repositories);
        const shared = 'shared-quote';
        const withShared = (
          operation: BatchMintOperation,
          ordinal: number,
        ): BatchMintOperation => ({
          ...operation,
          members: operation.members.map((value) =>
            value.ordinal === ordinal ? { ...value, quoteId: shared } : value,
          ),
        });
        const late = withShared(fixtures('b-late', CREATED_AT + 20).executing, 2);
        const tieB = withShared(fixtures('tie-b', CREATED_AT + 10).finalized, 0);
        const tieA = withShared(fixtures('tie-a', CREATED_AT + 10).executing, 1);
        const failed = withShared(fixtures('a-failed', CREATED_AT).failed, 0);
        const unrelated = fixtures('unrelated', CREATED_AT + 5).executing;
        const otherMint = {
          ...withShared(fixtures('other-mint').executing, 0),
          mintUrl: 'https://other.example',
        };
        for (const operation of [late, tieB, tieA, failed, unrelated, otherMint]) {
          await repository.create(operation);
        }

        expect(ids(await repository.listByState('executing'))).toBe(
          JSON.stringify(['other-mint', 'unrelated', 'tie-a', 'b-late']),
        );
        expect(ids(await repository.listByState('finalized'))).toBe(JSON.stringify(['tie-b']));
        expect(ids(await repository.listByState('failed'))).toBe(JSON.stringify(['a-failed']));
        expect(ids(await repository.listInFlight())).toBe(
          JSON.stringify(['other-mint', 'unrelated', 'tie-a', 'b-late']),
        );
        const byQuote = await repository.listByQuote({ mintUrl: `${MINT_URL}/`, quoteId: shared });
        expect(ids(byQuote)).toBe(JSON.stringify(['a-failed', 'tie-a', 'tie-b', 'b-late']));
        for (const operation of byQuote) expect(ordinals(operation)).toBe('[0,1,2]');
        expect(
          await repository.listByQuote({ mintUrl: MINT_URL, quoteId: 'unknown-quote' }),
        ).toHaveLength(0);
      }));

    it('stores normalized mint URLs', () =>
      withRepositories(options, async (repositories) => {
        const repository = requireBatchMint(repositories);
        const operation = { ...fixtures('normalized').executing, mintUrl: `${MINT_URL}/` };
        await repository.create(operation);
        expect((await repository.getById(operation.id))?.mintUrl).toBe(MINT_URL);
      }));

    it('commits and rolls back operations and members with the Wallet transaction', () =>
      withRepositories(options, async (repositories) => {
        const { executing, finalized } = fixtures('atomic');
        const [first] = executing.members as [BatchMintMember];
        await repositories.withTransaction(async (scope) => {
          await requireBatchMint(scope).create(executing);
        });
        expect(comparable(await requireBatchMint(repositories).getById(executing.id))).toBe(
          comparable(executing),
        );

        const failure = new Error('rollback batch mint');
        const rolledBack = fixtures('rolled-back').executing;
        let thrown: unknown;
        try {
          await repositories.withTransaction(async (scope) => {
            await requireBatchMint(scope).update(finalized);
            await requireBatchMint(scope).create(rolledBack);
            throw failure;
          });
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBe(failure);
        const repository = requireBatchMint(repositories);
        expect((await repository.getById(executing.id))?.state).toBe('executing');
        expect(await repository.getById(rolledBack.id)).toBe(null);
        expect(
          ids(await repository.listByQuote({ mintUrl: MINT_URL, quoteId: first.quoteId })),
        ).toBe(JSON.stringify([executing.id]));
        expect(
          await repository.listByQuote({
            mintUrl: MINT_URL,
            quoteId: rolledBack.members[0]!.quoteId,
          }),
        ).toHaveLength(0);
      }));
  });
}

async function withRepositories(
  options: BatchMintContractOptions,
  run: (repositories: Repositories) => Promise<void>,
): Promise<void> {
  const { repositories, dispose } = await options.createRepositories();
  try {
    await run(repositories);
  } finally {
    await dispose();
  }
}

async function expectRejects(
  fn: () => Promise<unknown>,
  expect: ContractRunner['expect'],
): Promise<void> {
  let rejected = false;
  try {
    await fn();
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
}

function requireBatchMint(repositories: Repositories | RepositoryTransactionScope) {
  return repositories.batchMint.operationRepository;
}

function historyView(entry: HistoryEntry | null): string {
  if (!entry || entry.type !== 'mint' || entry.source !== 'operation') return JSON.stringify(entry);
  return JSON.stringify([
    entry.id,
    entry.source,
    entry.type,
    entry.mintUrl,
    entry.unit,
    entry.operationId,
    entry.batchMintOperationId ?? null,
    entry.quoteId,
    entry.paymentRequest,
    entry.amount.toString(),
    entry.state,
    entry.createdAt,
    entry.updatedAt,
    entry.error ?? null,
  ]);
}

/**
 * Each Batch Mint Member is an ordinary `type: 'mint'` history entry with its own quote, request
 * and amount, the batch's state, `operationId` and `batchMintOperationId` set to the batch ID, and
 * a per-member entry ID `batch-mint:<id>:<ordinal>`.
 */
export function runBatchMintHistoryContract(
  options: BatchMintContractOptions,
  runner: ContractRunner,
): void {
  const { describe, it, expect } = runner;
  const memberEntry = (operation: BatchMintOperation, ordinal: number) => {
    const member = operation.members.find((candidate) => candidate.ordinal === ordinal)!;
    return JSON.stringify([
      `batch-mint:${operation.id}:${ordinal}`,
      'operation',
      'mint',
      operation.mintUrl,
      operation.unit,
      operation.id,
      operation.id,
      member.quoteId,
      member.request,
      member.amount.toString(),
      operation.state,
      operation.createdAt,
      operation.updatedAt,
      operation.error ?? null,
    ]);
  };

  describe('Batch Mint history projection contract', () => {
    it('projects one mint history entry per member in history order', () =>
      withRepositories(options, async (repositories) => {
        const { finalized } = fixtures('batch');
        await repositories.batchMint.operationRepository.create(finalized);

        const entries = await repositories.historyRepository.getPaginatedHistoryEntries(10, 0);

        expect(JSON.stringify(entries.map(historyView))).toBe(
          JSON.stringify([2, 1, 0].map((ordinal) => memberEntry(finalized, ordinal))),
        );
        const page = await repositories.historyRepository.getPaginatedHistoryEntries(1, 1);
        expect(JSON.stringify(page.map(historyView))).toBe(
          JSON.stringify([memberEntry(finalized, 1)]),
        );
      }));

    it('resolves member entries by ID and follows the batch state', () =>
      withRepositories(options, async (repositories) => {
        const { executing, failed } = fixtures('batch');
        await repositories.batchMint.operationRepository.create(executing);
        expect(
          historyView(
            await repositories.historyRepository.getHistoryEntryById('batch-mint:batch:2'),
          ),
        ).toBe(memberEntry(executing, 2));

        await repositories.batchMint.operationRepository.update(failed);

        expect(
          historyView(
            await repositories.historyRepository.getHistoryEntryById('batch-mint:batch:0'),
          ),
        ).toBe(memberEntry(failed, 0));
        expect(await repositories.historyRepository.getHistoryEntryById('batch-mint:batch:3')).toBe(
          null,
        );
        expect(
          await repositories.historyRepository.getHistoryEntryById('batch-mint:missing:0'),
        ).toBe(null);
        expect(await repositories.historyRepository.getHistoryEntryById('mint:batch')).toBe(null);
      }));
  });
}
