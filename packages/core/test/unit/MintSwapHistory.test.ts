import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import { EventBus, type CoreEvents } from '../../events';
import type { HistoryEntry } from '../../models/History.ts';
import type { HistoryProjectionRepository, MintSwapOperationRepository } from '../../repositories';
import { HistoryService } from '../../services/HistoryService.ts';
import { makePreparedMintSwapOperation } from '../fixtures/MintSwap.ts';

function sendEntry(
  id: string,
  createdAt: number,
  mintUrl = 'https://source.mint.test',
): HistoryEntry {
  return {
    id: `send:${id}`,
    source: 'operation',
    type: 'send',
    createdAt,
    updatedAt: createdAt,
    mintUrl,
    unit: 'sat',
    operationId: id,
    amount: Amount.from(1),
    state: 'finalized',
  };
}

function mintEntry(id: string, createdAt: number): HistoryEntry {
  return {
    id: `mint:${id}`,
    source: 'operation',
    type: 'mint',
    createdAt,
    updatedAt: createdAt,
    mintUrl: 'https://destination.mint.test',
    unit: 'sat',
    operationId: id,
    quoteId: 'quote',
    paymentRequest: 'invoice',
    amount: Amount.from(1),
    state: 'finalized',
  };
}

describe('Mint Swap grouped history', () => {
  it('paginates beyond 10,000 rows and suppresses owned children in one batch', async () => {
    const parent = makePreparedMintSwapOperation({
      id: 'parent',
      destinationMintOperationId: 'owned-mint',
      sourceMeltOperationId: 'owned-melt',
      createdAt: 20_100,
      updatedAt: 20_100,
    });
    const ordinary = [
      mintEntry('owned-mint', 20_000),
      ...Array.from({ length: 10_020 }, (_, index) => sendEntry(`send-${index}`, 19_999 - index)),
    ];
    const historyRepository: HistoryProjectionRepository = {
      getPaginatedHistoryEntries: async (limit, offset) => ordinary.slice(offset, offset + limit),
      getHistoryEntryById: async () => null,
    };
    const getByChildOperationIds = mock(async (ids: readonly string[]) =>
      ids.includes('owned-mint') ? [parent] : [],
    );
    const parentRepository = {
      getPaginated: async (limit: number, offset: number) => [parent].slice(offset, offset + limit),
      getByChildOperationIds,
      getById: async () => parent,
    } as unknown as MintSwapOperationRepository;
    const service = new HistoryService(
      historyRepository,
      new EventBus<CoreEvents>(),
      undefined,
      parentRepository,
    );

    const page = await service.getPaginatedHistory(10_010, 5);

    expect(page).toHaveLength(5);
    expect(page.every((entry) => entry.id !== 'mint:owned-mint')).toBe(true);
    expect(getByChildOperationIds.mock.calls.length).toBeLessThan(4);
  });

  it('normalizes two-sided mint filters and can explicitly include owned children', async () => {
    const parent = makePreparedMintSwapOperation({
      id: 'parent',
      destinationMintOperationId: 'owned-mint',
    });
    const child = mintEntry('owned-mint', parent.createdAt - 1);
    const historyRepository: HistoryProjectionRepository = {
      getPaginatedHistoryEntries: async () => [child],
      getHistoryEntryById: async () => null,
    };
    const parentRepository = {
      getPaginated: async (_limit: number, _offset: number, mintUrl?: string) =>
        !mintUrl || mintUrl === parent.destinationMintUrl ? [parent] : [],
      getByChildOperationIds: async () => [parent],
      getById: async () => parent,
    } as unknown as MintSwapOperationRepository;
    const service = new HistoryService(
      historyRepository,
      new EventBus<CoreEvents>(),
      undefined,
      parentRepository,
    );

    const filtered = await service.getPaginatedHistory(0, 10, {
      mintUrl: `${parent.destinationMintUrl}/`,
    });
    expect(filtered.map((entry) => entry.id)).toEqual([`mint-swap:${parent.id}`]);

    const withChildren = await service.getPaginatedHistory(0, 10, {
      includeOwnedChildren: true,
    });
    expect(withChildren.map((entry) => entry.id)).toContain(child.id);
    expect(await service.getHistoryEntryById(`mint-swap:${parent.id}`)).toMatchObject({
      type: 'mint-swap',
      sourceMintUrl: parent.sourceMintUrl,
      destinationMintUrl: parent.destinationMintUrl,
    });
  });
});
