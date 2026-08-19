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

    const parent = { kind: 'mint-swap' as const, id: 'concurrent-mint-swap' };
    expect(
      await repository.assignMintSwapParentIfUnparented(staleOperation.id, 'pending', parent),
    ).toBe(true);

    await repository.update({ ...staleOperation, state: 'executing' });

    const stored = await repository.getById(staleOperation.id);
    expect(stored?.state).toBe('executing');
    expect(stored?.parent).toEqual(parent);
  });

  it('rejects a duplicate Mint Swap claim for a parented operation', async () => {
    const repository = new MemoryMintOperationRepository();
    const operation = createPendingOperation('duplicate-mint-swap-claim');
    await repository.create(operation);
    const parent = { kind: 'mint-swap' as const, id: 'first-mint-swap' };

    expect(await repository.assignMintSwapParentIfUnparented(operation.id, 'pending', parent)).toBe(
      true,
    );

    expect(
      await repository.assignMintSwapParentIfUnparented(operation.id, 'pending', {
        kind: 'mint-swap',
        id: 'second-mint-swap',
      }),
    ).toBe(false);

    const stored = await repository.getById(operation.id);
    expect(stored?.parent).toEqual(parent);
  });
});
