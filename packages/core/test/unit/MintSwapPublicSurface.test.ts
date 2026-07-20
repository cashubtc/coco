import { Amount } from '@cashu/cashu-ts';
import { describe, expect, it, mock } from 'bun:test';

import { MintSwapOpsApi } from '../../api/MintSwapOpsApi.ts';
import { EventBus, type CoreEvents } from '../../events/index.ts';
import type { HistoryEntry } from '../../models/History.ts';
import { projectMintSwapOperation } from '../../models/History.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/index.ts';
import { MemoryRepositories } from '../../repositories/memory/MemoryRepositories.ts';
import type { HistoryProjectionRepository } from '../../repositories/index.ts';
import { HistoryService } from '../../services/HistoryService.ts';
import { makePreparedMintSwapOperation } from '../fixtures/MintSwap.ts';

describe('mint swap public surface', () => {
  it('projects one sanitized grouped history entry with preview and settlement facts', () => {
    const operation = makePreparedMintSwapOperation({
      state: 'needs_attention',
      attention: {
        reason: 'accounting_mismatch',
        message: 'Destination amount did not reconcile',
        lastSafeState: 'destination_funded',
        violatedInvariant: 'destination amount',
        evidence: { operationId: 'swap-1' },
        at: Date.now(),
      },
    });
    const entry = projectMintSwapOperation(operation);
    expect(entry).toMatchObject({
      id: 'mint-swap:swap-1',
      type: 'mint-swap',
      sourceMintUrl: 'https://source.test',
      destinationMintUrl: 'https://destination.test',
      reasonCode: 'accounting_mismatch',
    });
    expect(entry.minimumSourceDebit?.toString()).toBe('102');
    expect(entry).not.toHaveProperty('destinationNut20Key');
  });

  it('suppresses parent-owned child rows from grouped history by default', async () => {
    const repositories = new MemoryRepositories();
    const parent = makePreparedMintSwapOperation({ revision: 0 });
    await repositories.mintSwapOperationRepository.create(parent);
    const entries: HistoryEntry[] = [
      childHistory('mint', parent.destinationMintOperationId!),
      childHistory('melt', parent.sourceMeltOperationId!),
      childHistory('send', 'standalone-child'),
    ];
    const historyRepository: HistoryProjectionRepository = {
      getPaginatedHistoryEntries: mock(async () => entries),
      getHistoryEntryById: mock(async () => null),
    };
    const service = new HistoryService(
      historyRepository,
      new EventBus<CoreEvents>(),
      undefined,
      repositories.mintSwapOperationRepository,
    );

    const history = await service.getPaginatedHistory();
    expect(history.map((entry) => entry.id).sort()).toEqual([
      'mint-swap:swap-1',
      'send:standalone-child',
    ]);
    expect(
      (await service.getPaginatedHistory(0, 25, { mintUrl: 'https://destination.test' })).map(
        (entry) => entry.id,
      ),
    ).toEqual(['mint-swap:swap-1']);
  });

  it('closes the subscribe/recheck waiter race and returns durable terminal state', async () => {
    const prepared = makePreparedMintSwapOperation();
    const completed = makePreparedMintSwapOperation({
      state: 'completed',
      revision: 5,
      settlement: {
        sourcePaymentFee: Amount.from(4),
        totalSourceFee: Amount.from(6),
        sourceMeltChangeAmount: Amount.from(4),
        sourceKeepAmount: Amount.zero(),
        sourceReturnedAmount: Amount.from(4),
        finalSourceDebit: Amount.from(106),
        destinationAmountIssued: Amount.from(100),
      },
      completedAt: Date.now(),
    });
    let reads = 0;
    const service = {
      get: mock(async () => (++reads === 1 ? prepared : completed)),
    } as unknown as MintSwapOperationService;
    const api = new MintSwapOpsApi(service, new EventBus<CoreEvents>());

    await expect(api.waitFor('swap-1', { timeoutMs: 100 })).resolves.toMatchObject({
      state: 'completed',
      revision: 5,
    });
    expect(reads).toBe(2);
  });
});

function childHistory(type: 'mint' | 'melt' | 'send', operationId: string): HistoryEntry {
  const base = {
    id: `${type}:${operationId}`,
    source: 'operation' as const,
    type,
    operationId,
    mintUrl: 'https://source.test',
    unit: 'sat',
    amount: Amount.from(100),
    state: 'prepared',
    createdAt: 1,
    updatedAt: 1,
  };
  if (type === 'mint') {
    return { ...base, type, quoteId: 'q', paymentRequest: 'lnbc1' } as HistoryEntry;
  }
  if (type === 'melt') return { ...base, type, quoteId: 'q' } as HistoryEntry;
  return { ...base, type } as HistoryEntry;
}
