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

    expect(
      await repository.claimForMintSwap(staleOperation.id, 'pending', 'concurrent-mint-swap'),
    ).toBe(true);

    await repository.update({ ...staleOperation, state: 'executing' });

    const stored = await repository.getById(staleOperation.id);
    expect(stored?.state).toBe('executing');
    expect(stored?.parent).toEqual({ kind: 'mint-swap', id: 'concurrent-mint-swap' });
  });

  it('rejects a duplicate Mint Swap claim for a parented operation', async () => {
    const repository = new MemoryMintOperationRepository();
    const operation = createPendingOperation('duplicate-mint-swap-claim');
    await repository.create(operation);
    expect(await repository.claimForMintSwap(operation.id, 'pending', 'first-mint-swap')).toBe(
      true,
    );

    expect(await repository.claimForMintSwap(operation.id, 'pending', 'second-mint-swap')).toBe(
      false,
    );

    const stored = await repository.getById(operation.id);
    expect(stored?.parent).toEqual({ kind: 'mint-swap', id: 'first-mint-swap' });
  });
});
