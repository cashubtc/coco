import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it } from 'bun:test';
import type { PendingMintOperation } from '../../operations/mint/MintOperation';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';

const createPendingOperation = (id: string): PendingMintOperation => ({
  id,
  state: 'pending',
  mintUrl: 'https://mint.test',
  method: 'bolt11',
  methodData: {},
  amount: Amount.from(30),
  unit: 'sat',
  quoteId: `${id}-quote`,
  request: 'lnbc30',
  expiry: null,
  outputData: { keep: [], send: [] },
  createdAt: 1_000,
  updatedAt: 1_000,
});

describe('MemoryMintOperationRepository', () => {
  it('preserves a concurrent ownership claim through a stale regular update', async () => {
    const repository = new MemoryMintOperationRepository();
    const staleOperation = createPendingOperation('stale-ownership');
    await repository.create(staleOperation);

    const parent = { kind: 'mint-batch' as const, id: 'concurrent-batch' };
    expect(
      await repository.updateIfStateAndParentMatch(
        { ...staleOperation, parent, batchingDisabled: true },
        { state: 'pending' },
      ),
    ).toBe(true);

    await repository.update({ ...staleOperation, state: 'executing' });

    const stored = await repository.getById(staleOperation.id);
    expect(stored?.state).toBe('executing');
    expect(stored?.parent).toEqual(parent);
    expect(stored?.batchingDisabled).toBe(true);
  });

  it('rejects a stale batch claim after batching is disabled', async () => {
    const repository = new MemoryMintOperationRepository();
    const operation = createPendingOperation('disabled-batching');
    await repository.create(operation);

    expect(
      await repository.updateIfStateAndParentMatch(
        { ...operation, batchingDisabled: true },
        { state: 'pending' },
      ),
    ).toBe(true);

    expect(
      await repository.updateIfStateAndParentMatch(
        { ...operation, parent: { kind: 'mint-batch', id: 'stale-batch' } },
        { state: 'pending' },
      ),
    ).toBe(false);

    const stored = await repository.getById(operation.id);
    expect(stored?.parent).toBe(undefined);
    expect(stored?.batchingDisabled).toBe(true);
  });
});
