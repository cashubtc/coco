import { Amount } from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect } from 'bun:test';
import type {
  DeferredReceiveOperation,
  ReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import { MemoryReceiveOperationRepository } from '../../repositories/memory/MemoryReceiveOperationRepository';

describe('MemoryReceiveOperationRepository', () => {
  const mintUrl = 'https://mint.test';

  let repo: MemoryReceiveOperationRepository;

  const makeProof = (secret: string): Proof =>
    ({
      id: 'keyset-1',
      amount: Amount.from(1),
      secret,
      C: `C_${secret}`,
    }) as Proof;

  const makeOperation = (
    id: string,
    state: ReceiveOperation['state'],
    extra?: Partial<ReceiveOperation>,
  ): ReceiveOperation =>
    ({
      id,
      state,
      mintUrl,
      unit: 'sat',
      amount: Amount.from(1),
      inputProofs: [makeProof(`${id}-p1`)],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...extra,
    }) as ReceiveOperation;

  beforeEach(() => {
    repo = new MemoryReceiveOperationRepository();
  });

  it('round-trips a deferred operation with its reason', async () => {
    const deferred = makeOperation('op-deferred', 'deferred', {
      deferredReason: 'dust',
    } as Partial<ReceiveOperation>);

    await repo.create(deferred);

    const stored = (await repo.getById('op-deferred')) as DeferredReceiveOperation;
    expect(stored.state).toBe('deferred');
    expect(stored.deferredReason).toBe('dust');
    expect(stored.amount).toEqual(Amount.from(1));
  });

  it('round-trips batchId on an executing operation', async () => {
    const executing = makeOperation('op-batch', 'executing', {
      batchId: 'batch-1',
    } as Partial<ReceiveOperation>);

    await repo.create(executing);

    const stored = await repo.getById('op-batch');
    expect(stored?.batchId).toBe('batch-1');
  });

  it('getPending returns executing and deferred operations only', async () => {
    await repo.create(makeOperation('op-init', 'init'));
    await repo.create(
      makeOperation('op-deferred', 'deferred', {
        deferredReason: 'mint-unreachable',
      } as Partial<ReceiveOperation>),
    );
    await repo.create(makeOperation('op-executing', 'executing'));
    await repo.create(makeOperation('op-finalized', 'finalized'));

    const pending = await repo.getPending();

    expect(pending.map((op) => op.id).sort()).toEqual(['op-deferred', 'op-executing']);
  });

  it('getByState filters deferred operations', async () => {
    await repo.create(
      makeOperation('op-deferred', 'deferred', {
        deferredReason: 'p2pk-unsigned',
      } as Partial<ReceiveOperation>),
    );
    await repo.create(makeOperation('op-executing', 'executing'));

    const deferred = await repo.getByState('deferred');

    expect(deferred.length).toBe(1);
    expect(deferred[0]?.id).toBe('op-deferred');
  });
});
