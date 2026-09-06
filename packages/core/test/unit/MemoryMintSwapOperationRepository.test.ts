import { describe, expect, it } from 'bun:test';
import { Amount } from '@cashu/cashu-ts';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import type {
  MintSwapOperationRepository,
  MintSwapPersistence,
} from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import { MemoryMintSwapOperationRepository } from '../../repositories/memory/MemoryMintSwapOperationRepository.ts';
import { mintSwapFixtures, MINT_SWAP_CREATED_AT as T } from '../fixtures/MintSwap.ts';

type Transition = Parameters<MintSwapOperationRepository['transition']>[0];
function command(current: MintSwapOperation, next: MintSwapOperation): Transition {
  return {
    operationId: current.id,
    expectedState: current.state,
    expectedRevision: current.revision,
    next,
  };
}
async function stored(
  repository: MintSwapOperationRepository,
  id = 'swap',
): Promise<MintSwapOperation> {
  const result = await repository.getById(id);
  if (!result) throw new Error('Expected persisted fixture');
  return result;
}

const identities = [
  'id',
  'sourceQuote',
  'destinationQuote',
  'sourceOperationId',
  'destinationOperationId',
] as const;

describe('Memory Mint Swap atomic create and all-time identity constraints', () => {
  it('creates at revision zero and returns null for an absent exact ID', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const operation = mintSwapFixtures().preparing;
    await repository.create(operation);
    expect(await repository.getById(operation.id)).toEqual(operation);
    expect(await repository.getById('absent')).toBeNull();
  });

  for (const identity of identities) {
    it(`has exactly one concurrent create winner for ${identity}`, async () => {
      const repository = new MemoryMintSwapOperationRepository();
      const first = mintSwapFixtures('first').preparing;
      const second = { ...mintSwapFixtures('second').preparing, [identity]: first[identity] };
      const results = await Promise.allSettled([
        repository.create(first),
        repository.create(second),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await repository.listActive()).toEqual([first]);
      // A rejected create cannot consume any of its otherwise-unused identities.
      const fresh = mintSwapFixtures('second').preparing;
      await repository.create(fresh);
      expect(await repository.listActive()).toEqual([first, fresh]);
    });

    for (const state of ['completed', 'cancelled', 'failed', 'needs_attention'] as const) {
      it(`retains ${identity} uniqueness after ${state}`, async () => {
        const repository = new MemoryMintSwapOperationRepository();
        const first = mintSwapFixtures('first')[state];
        await repository.create(first);
        const second = { ...mintSwapFixtures('second').preparing, [identity]: first[identity] };
        await expect(repository.create(second)).rejects.toThrow();
        expect(await repository.getById('first')).toEqual(first);
        expect(await repository.getById('second')).toBeNull();
        await repository.create(mintSwapFixtures('second').preparing);
      });
    }
  }

  it('keeps quote identities mint-scoped and Mint/Melt namespaces separate', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const first = mintSwapFixtures('first').preparing;
    first.sourceQuote.quoteId = 'same-quote';
    first.destinationQuote.quoteId = 'same-quote';
    await repository.create(first);
    const second = mintSwapFixtures('second').preparing;
    second.sourceMintUrl = first.destinationMintUrl;
    second.destinationMintUrl = first.sourceMintUrl;
    second.sourceQuote = { ...first.destinationQuote };
    second.destinationQuote = { ...first.sourceQuote };
    second.sourceOperationId = first.destinationOperationId;
    second.destinationOperationId = first.sourceOperationId;
    await repository.create(second);
    expect(await repository.listActive()).toEqual([first, second]);
  });

  it('rejects noncanonical quote aliases before indexes or storage can change', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const first = mintSwapFixtures('first').preparing;
    await repository.create(first);
    const alias = mintSwapFixtures('second').preparing;
    alias.sourceMintUrl = 'https://SOURCE.example/';
    alias.sourceQuote = { ...first.sourceQuote, mintUrl: alias.sourceMintUrl };
    await expect(repository.create(alias)).rejects.toThrow(TypeError);
    expect(await repository.listActive()).toEqual([first]);
    await repository.create(mintSwapFixtures('second').preparing);
  });

  it('rejects invalid creation and nonzero revisions without reserving identities', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const fixture = mintSwapFixtures().preparing;
    for (const revision of [-1, 1, 2, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.create({ ...fixture, revision })).rejects.toThrow(TypeError);
      expect(await repository.listActive()).toEqual([]);
    }
    await expect(
      repository.create({ ...fixture, destinationAmount: Amount.zero() }),
    ).rejects.toThrow(TypeError);
    expect(await repository.getById(fixture.id)).toBeNull();
    await repository.create(fixture);
    expect(await stored(repository)).toEqual(fixture);
  });
});

describe('Memory Mint Swap conditional transitions', () => {
  it('stamps exactly one increment and never mutates or trusts next.revision', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    await repository.create(mintSwapFixtures().preparing);
    for (const carriedRevision of [0, 100, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const current = await stored(repository);
      const next = { ...current, revision: carriedRevision, updatedAt: current.updatedAt + 1 };
      expect(await repository.transition(command(current, next))).toBe(true);
      expect((await stored(repository)).revision).toBe(current.revision + 1);
      expect(next.revision).toBe(carriedRevision);
    }
  });

  it('has exactly one concurrent state transition winner', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const { preparing, prepared } = mintSwapFixtures();
    await repository.create(preparing);
    const outcomes = await Promise.all([
      repository.transition(command(preparing, prepared)),
      repository.transition(command(preparing, prepared)),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await stored(repository)).toEqual({ ...prepared, revision: 1 });
  });

  it('same-state metadata writes increment once and invalidate stale writers', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const before = mintSwapFixtures().source_pending;
    await repository.create(before);
    const next: MintSwapOperation = {
      ...before,
      updatedAt: T + 2_100,
      retry: {
        attemptCount: 1,
        lastAttemptAt: T + 2_100,
        nextAttemptAt: T + 4_100,
        lastError: { category: 'waiting', code: 'source_pending', at: T + 2_100 },
      },
    };
    const outcomes = await Promise.all([
      repository.transition(command(before, next)),
      repository.transition(command(before, { ...next, updatedAt: T + 2_101 })),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    const winner = await stored(repository);
    expect(winner).toEqual({ ...next, revision: 1 });
    expect(winner.state).toBe(before.state);
    expect(winner.stateEnteredAt).toBe(before.stateEnteredAt);
    expect(winner.cancellationRequestedAt).toBe(before.cancellationRequestedAt);
    expect(await repository.transition(command(before, next))).toBe(false);
    expect(await stored(repository)).toEqual(winner);
  });

  for (const [name, guard] of [
    ['missing ID', { operationId: 'missing' }],
    ['wrong state', { expectedState: 'prepared' }],
    ['stale revision', { expectedRevision: 1 }],
  ] as const) {
    it(`returns false for ${name} without parsing the candidate or changing anything`, async () => {
      const repository = new MemoryMintSwapOperationRepository();
      const { preparing, prepared } = mintSwapFixtures();
      await repository.create(preparing);
      expect(
        await repository.transition({
          ...command(preparing, { ...prepared, destinationAmount: Amount.zero() }),
          ...guard,
        }),
      ).toBe(false);
      expect(await stored(repository)).toEqual(preparing);
      expect(await repository.listDue(T, 100)).toEqual([preparing]);
    });
  }

  it('throws for a mismatched next ID without inserting or modifying either record', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const { preparing, prepared } = mintSwapFixtures();
    await repository.create(preparing);
    await expect(
      repository.transition(command(preparing, { ...prepared, id: 'different' })),
    ).rejects.toThrow(TypeError);
    expect(await stored(repository)).toEqual(preparing);
    expect(await repository.getById('different')).toBeNull();
  });

  it('rejects illegal transitions, malformed evidence and immutable edits without mutation', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const fixtures = mintSwapFixtures();
    await repository.create(fixtures.prepared);
    const invalidCandidates: MintSwapOperation[] = [
      fixtures.completed,
      { ...fixtures.source_pending, sourceOperationId: 'replacement' },
      {
        ...fixtures.source_pending,
        sourceQuote: { ...fixtures.source_pending.sourceQuote, quoteId: 'replacement' },
      },
      {
        ...fixtures.source_pending,
        sourceDebitBounds: {
          ...fixtures.source_pending.sourceDebitBounds,
          minimum: Amount.from(99),
        },
      },
      {
        ...fixtures.source_pending,
        sourceDebitBounds: {
          ...fixtures.source_pending.sourceDebitBounds,
          minimum: Amount.from(101),
        },
      },
      { ...fixtures.source_pending, updatedAt: T + 1_999 },
      { ...fixtures.source_pending, cancellationRequestedAt: undefined },
    ];
    for (const next of invalidCandidates) {
      await expect(repository.transition(command(fixtures.prepared, next))).rejects.toThrow(
        TypeError,
      );
      expect(await stored(repository)).toEqual(fixtures.prepared);
      expect(await repository.listActive()).toEqual([fixtures.prepared]);
    }
    expect(await repository.transition(command(fixtures.prepared, fixtures.source_pending))).toBe(
      true,
    );
  });

  it('rejects unsafe revision increments atomically when hydrating the largest safe revision', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const persisted = { ...mintSwapFixtures().preparing, revision: Number.MAX_SAFE_INTEGER };
    // Simulate persisted hydration at the limit without performing 2^53 writes.
    const storage = Reflect.get(repository, 'operations') as Map<string, MintSwapOperation>;
    storage.set(persisted.id, persisted);
    await expect(repository.transition(command(persisted, persisted))).rejects.toThrow(TypeError);
    expect(await stored(repository)).toEqual(persisted);
  });

  it('exposes no blind authoritative update or delete path', () => {
    const repository: MintSwapOperationRepository = new MemoryMintSwapOperationRepository();
    expect('update' in repository).toBe(false);
    expect('delete' in repository).toBe(false);
    const capability: MintSwapPersistence = { operationRepository: repository };
    expect(capability.operationRepository).toBe(repository);
  });
});

describe('Memory Mint Swap defensive reads and due scans', () => {
  it('reconstructs every state and nested evidence without input, transition, or read aliases', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    for (const state of Object.keys(mintSwapFixtures()) as Array<
      keyof ReturnType<typeof mintSwapFixtures>
    >) {
      const fixture = mintSwapFixtures(state)[state];
      await repository.create(fixture);
      fixture.sourceQuote.quoteId = 'mutated';
      const read = await stored(repository, state);
      expect(read).toEqual(mintSwapFixtures(state)[state]);
      expect(read.destinationAmount).toBeInstanceOf(Amount);
      read.destinationQuote.quoteId = 'mutated';
      read.destinationAmount = Amount.zero();
      if (read.lastSafe?.sourceDebitBounds)
        read.lastSafe.sourceDebitBounds.reserved = Amount.zero();
      if (read.sourceSettlement) read.sourceSettlement.returned = Amount.zero();
      if (read.attention) read.attention.evidence.code = 'child_missing';
      expect(await stored(repository, state)).toEqual(mintSwapFixtures(state)[state]);
    }
    const before = await stored(repository, 'preparing');
    const next = mintSwapFixtures('preparing').prepared;
    await repository.transition(command(before, next));
    next.sourceDebitBounds.maximum = Amount.zero();
    expect(await stored(repository, 'preparing')).toEqual({
      ...mintSwapFixtures('preparing').prepared,
      revision: 1,
    });
  });

  it('hydrates byte-like digests and persisted decimal Amount values', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const digest = new Uint8Array(32).fill(171);
    const hydrated = JSON.parse(JSON.stringify(mintSwapFixtures().prepared));
    hydrated.paymentRequestHash = digest;
    await repository.create(hydrated);
    digest.fill(0);
    const read = await stored(repository);
    expect(read).toEqual(mintSwapFixtures().prepared);
    expect(read.sourceDebitBounds?.minimum).toBeInstanceOf(Amount);
  });

  it('parses persisted records on every read instead of trusting in-memory shapes', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    await repository.create(mintSwapFixtures().preparing);
    const storage = Reflect.get(repository, 'operations') as Map<string, MintSwapOperation>;
    const malformed = { ...mintSwapFixtures().preparing, destinationAmount: Amount.zero() };
    storage.set(malformed.id, malformed);
    await expect(repository.getById(malformed.id)).rejects.toThrow(TypeError);
    await expect(repository.listActive()).rejects.toThrow(TypeError);
    await expect(repository.listDue(T, 1)).rejects.toThrow(TypeError);
  });

  it('lists all nonterminal states including prepared/attention, ordered by creation then ID', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    const fixtures = mintSwapFixtures();
    const states = Object.keys(fixtures) as Array<keyof typeof fixtures>;
    for (const state of states.toReversed())
      await repository.create(mintSwapFixtures(state)[state]);
    await repository.create(mintSwapFixtures('oldest', T - 1).preparing);
    const active = await repository.listActive();
    expect(active.map((op) => op.id)).toEqual([
      'oldest',
      'destination_funded',
      'destination_pending',
      'needs_attention',
      'prepared',
      'preparing',
      'source_pending',
    ]);
    active[0]!.sourceQuote.quoteId = 'mutated';
    expect((await stored(repository, 'oldest')).sourceQuote.quoteId).toBe('melt-oldest');
  });

  it('selects automatic states inclusively by due time and orders due/creation/ID deterministically', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    for (const state of [
      'preparing',
      'prepared',
      'source_pending',
      'destination_funded',
      'destination_pending',
      'completed',
      'cancelled',
      'failed',
      'needs_attention',
    ] as const) {
      await repository.create(mintSwapFixtures(state)[state]);
    }
    expect(await repository.listDue(T - 1, 10)).toEqual([]);
    expect((await repository.listDue(T + 4_000, 10)).map((op) => op.state)).toEqual([
      'preparing',
      'source_pending',
      'destination_funded',
      'destination_pending',
    ]);
    const preparing = await stored(repository, 'preparing');
    const delayed: MintSwapOperation = {
      ...preparing,
      retry: {
        attemptCount: 1,
        lastAttemptAt: T,
        nextAttemptAt: T + 10_000,
        lastError: { category: 'transient', code: 'remote_unavailable', at: T },
      },
    };
    await repository.transition(command(preparing, delayed));
    expect((await repository.listDue(T + 4_000, 2)).map((op) => op.state)).toEqual([
      'source_pending',
      'destination_funded',
    ]);
    expect((await repository.listDue(T + 10_000, 10)).at(-1)?.id).toBe('preparing');
    expect(await repository.listDue(T + 10_000, 0)).toEqual([]);
    const due = await repository.listDue(T + 10_000, 10);
    due.at(-1)!.retry.lastError!.at = 0;
    expect((await stored(repository, 'preparing')).retry.lastError!.at).toBe(T);
  });

  it('breaks equal due-time ties by creation time, then raw ID order', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    for (const [id, created] of [
      ['b', T],
      ['a', T],
      ['older', T - 1],
    ] as const) {
      const fixture = mintSwapFixtures(id, created).preparing;
      const operation: MintSwapOperation = {
        ...fixture,
        retry: {
          attemptCount: 1,
          lastAttemptAt: created,
          nextAttemptAt: T + 1_000,
          lastError: { category: 'waiting', code: 'child_pending', at: created },
        },
      };
      await repository.create(operation);
    }
    expect((await repository.listDue(T + 1_000, 10)).map((op) => op.id)).toEqual([
      'older',
      'a',
      'b',
    ]);
  });

  it('validates due-scan time and limit without mutation', async () => {
    const repository = new MemoryMintSwapOperationRepository();
    await repository.create(mintSwapFixtures().preparing);
    for (const invalid of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(repository.listDue(invalid, 1)).rejects.toThrow(TypeError);
      await expect(repository.listDue(T, invalid)).rejects.toThrow(TypeError);
    }
    expect(await stored(repository)).toEqual(mintSwapFixtures().preparing);
  });
});

function persistenceTypeChecks(
  repository: MintSwapOperationRepository,
  operation: MintSwapOperation,
) {
  // @ts-expect-error There is no unguarded update command.
  repository.update(operation);
  // @ts-expect-error Revision cannot be assigned by a caller.
  operation.revision++;
}
