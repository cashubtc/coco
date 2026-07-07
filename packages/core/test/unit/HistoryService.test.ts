import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { HistoryEntry, LegacyHistoryEntry } from '../../models/History';
import type { HistoryRepository } from '../../repositories';
import { HistoryService } from '../../services/HistoryService';
import type { FinalizedMeltOperation, PreparedMeltOperation } from '../../operations/melt';
import type { FailedMintOperation } from '../../operations/mint';
import type {
  FinalizedReceiveOperation,
  PreparedReceiveOperation,
  RolledBackReceiveOperation,
} from '../../operations/receive/ReceiveOperation';
import type {
  PendingSendOperation,
  PreparedSendOperation,
} from '../../operations/send/SendOperation';

describe('HistoryService', () => {
  let service: HistoryService;
  let eventBus: EventBus<CoreEvents>;
  let historyUpdateEvents: Array<{ mintUrl: string; entry: HistoryEntry }>;
  let repositoryEntries: Map<string, HistoryEntry>;

  const mintUrl = 'https://mint.test';
  const receiveProofs = [{ id: 'keyset-1', amount: Amount.from(42), secret: 'secret-1', C: 'C-1' }];

  beforeEach(() => {
    repositoryEntries = new Map();
    historyUpdateEvents = [];
    eventBus = new EventBus<CoreEvents>();
    eventBus.on('history:updated', (payload) => {
      historyUpdateEvents.push(payload);
      repositoryEntries.set(payload.entry.id, payload.entry);
    });

    const historyRepository: HistoryRepository = {
      async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
        return Array.from(repositoryEntries.values()).slice(offset, offset + limit);
      },
      async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
        return repositoryEntries.get(id) ?? null;
      },
    };

    service = new HistoryService(historyRepository, eventBus);
  });

  it('emits deterministic operation-backed send entries from send lifecycle events', async () => {
    const prepared = makePreparedSendOperation('send-op-1');
    const pending = {
      ...prepared,
      state: 'pending',
      token: { mint: mintUrl, proofs: receiveProofs, unit: 'usd' },
    } as PendingSendOperation;

    await eventBus.emit('send:prepared', {
      mintUrl,
      operationId: prepared.id,
      operation: prepared,
    });
    await eventBus.emit('send:pending', {
      mintUrl,
      operationId: pending.id,
      operation: pending,
      token: pending.token!,
    });

    expect(historyUpdateEvents).toHaveLength(2);
    expect(historyUpdateEvents[0]?.entry).toMatchObject({
      id: `send:${prepared.id}`,
      source: 'operation',
      type: 'send',
      operationId: prepared.id,
      state: 'prepared',
      unit: 'usd',
    });
    expect(historyUpdateEvents[1]?.entry).toMatchObject({
      id: `send:${pending.id}`,
      source: 'operation',
      type: 'send',
      operationId: pending.id,
      state: 'pending',
      unit: 'usd',
      token: pending.token,
    });
  });

  it('returns memo-bearing send token projections from paginated history', async () => {
    const prepared = makePreparedSendOperation('send-op-memo');
    const pending = {
      ...prepared,
      state: 'pending',
      token: { mint: mintUrl, proofs: receiveProofs, unit: 'usd', memo: 'hello' },
    } as PendingSendOperation;

    await eventBus.emit('send:pending', {
      mintUrl,
      operationId: pending.id,
      operation: pending,
      token: pending.token!,
    });

    const history = await service.getPaginatedHistory(0, 10);
    const sendEntry = history.find((entry) => entry.type === 'send');

    expect(sendEntry?.token?.memo).toBe('hello');
  });

  it('projects melt operation states without mapping them to quote states', async () => {
    const prepared = makePreparedMeltOperation('melt-op-1', 'quote-1');
    const finalized = {
      ...prepared,
      state: 'finalized',
      changeAmount: Amount.from(0),
      effectiveFee: Amount.from(10),
    } as FinalizedMeltOperation;

    await eventBus.emit('melt-op:prepared', {
      mintUrl,
      operationId: prepared.id,
      operation: prepared,
    });
    await eventBus.emit('melt-op:finalized', {
      mintUrl,
      operationId: finalized.id,
      operation: finalized,
    });

    expect(historyUpdateEvents[0]?.entry).toMatchObject({
      id: `melt:${prepared.id}`,
      source: 'operation',
      type: 'melt',
      quoteId: prepared.quoteId,
      state: 'prepared',
    });
    expect(historyUpdateEvents[1]?.entry).toMatchObject({
      id: `melt:${finalized.id}`,
      source: 'operation',
      type: 'melt',
      quoteId: finalized.quoteId,
      state: 'finalized',
    });
  });

  it('does not expose melt failed entries until persistence supports that state', async () => {
    const failed = {
      ...makePreparedMeltOperation('melt-op-failed', 'quote-failed'),
      state: 'failed',
      error: 'failed',
    } as never;

    await eventBus.emit('melt-op:finalized', {
      mintUrl,
      operationId: 'melt-op-failed',
      operation: failed,
    });

    expect(historyUpdateEvents).toHaveLength(0);
  });

  it('projects failed mint operation state from mint failure events', async () => {
    const failed = makeFailedMintOperation('mint-op-1', 'quote-1');

    await eventBus.emit('mint-op:failed', {
      mintUrl,
      operationId: failed.id,
      operation: failed,
    });

    expect(historyUpdateEvents).toHaveLength(1);
    expect(historyUpdateEvents[0]?.entry).toMatchObject({
      id: `mint:${failed.id}`,
      source: 'operation',
      type: 'mint',
      quoteId: failed.quoteId,
      state: 'failed',
      error: 'expired',
    });
  });

  it('ignores receive prepared and emits only terminal receive history', async () => {
    const prepared = makePreparedReceiveOperation('receive-op-1');
    const finalized = { ...prepared, state: 'finalized' } as FinalizedReceiveOperation;
    const rolledBack = {
      ...prepared,
      id: 'receive-op-2',
      state: 'rolled_back',
      error: 'cancelled',
    } as RolledBackReceiveOperation;

    await eventBus.emit('receive-op:prepared', {
      mintUrl,
      operationId: prepared.id,
      operation: prepared,
    });
    await eventBus.emit('receive-op:finalized', {
      mintUrl,
      operationId: finalized.id,
      operation: finalized,
    });
    await eventBus.emit('receive-op:rolled-back', {
      mintUrl,
      operationId: rolledBack.id,
      operation: rolledBack,
    });

    expect(historyUpdateEvents).toHaveLength(2);
    expect(historyUpdateEvents[0]?.entry).toMatchObject({
      id: `receive:${finalized.id}`,
      source: 'operation',
      type: 'receive',
      state: 'finalized',
      token: {
        mint: mintUrl,
        proofs: receiveProofs,
        unit: 'sat',
      },
      metadata: {
        source: 'payment-request',
        requestOperationId: 'request-op-1',
        requestId: 'request-1',
        attemptId: 'attempt-1',
        transport: 'nostr',
        transportMessageId: 'message-1',
        senderPubkey: 'sender-1',
        memo: 'memo-1',
      },
    });
    expect(historyUpdateEvents[1]?.entry).toMatchObject({
      id: `receive:${rolledBack.id}`,
      source: 'operation',
      type: 'receive',
      state: 'rolled_back',
      error: 'cancelled',
    });
  });

  it('reads paginated history and operation ids through the projection repository', async () => {
    const entry = {
      id: 'send:send-op-1',
      source: 'operation',
      type: 'send',
      operationId: 'send-op-1',
      mintUrl,
      amount: Amount.from(1),
      unit: 'sat',
      state: 'pending',
      createdAt: 1,
      updatedAt: 2,
    } satisfies HistoryEntry;
    repositoryEntries.set(entry.id, entry);

    await expect(service.getPaginatedHistory(0, 10)).resolves.toEqual([entry]);
    await expect(service.getOperationIdFromHistoryEntry(entry.id)).resolves.toBe('send-op-1');
  });

  it('rejects operation-id lookup for legacy send entries without an operation id', async () => {
    const legacy = {
      id: 'legacy:1',
      source: 'legacy',
      legacyHistoryId: '1',
      type: 'send',
      mintUrl,
      amount: Amount.from(1),
      unit: 'sat',
      state: 'pending',
      createdAt: 1,
      updatedAt: 1,
    } satisfies LegacyHistoryEntry;
    repositoryEntries.set(legacy.id, legacy);

    await expect(service.getOperationIdFromHistoryEntry(legacy.id)).rejects.toThrow(
      'not backed by an operation',
    );
  });

  function makePreparedSendOperation(id: string): PreparedSendOperation {
    return {
      id,
      state: 'prepared',
      mintUrl,
      amount: Amount.from(100),
      unit: 'usd',
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(100),
      inputProofSecrets: ['secret-1'],
      createdAt: 1_000,
      updatedAt: 2_000,
    };
  }

  function makePreparedMeltOperation(id: string, quoteId: string): PreparedMeltOperation {
    return {
      id,
      state: 'prepared',
      mintUrl,
      method: 'bolt11',
      methodData: { invoice: `lnbc-${quoteId}` },
      unit: 'sat',
      amount: Amount.from(100),
      needsSwap: false,
      fee_reserve: Amount.from(10),
      quoteId,
      swap_fee: Amount.from(0),
      inputAmount: Amount.from(110),
      inputProofSecrets: ['secret-1'],
      changeOutputData: { keep: [], send: [] },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
  }

  function makeFailedMintOperation(id: string, quoteId: string): FailedMintOperation {
    return {
      id,
      state: 'failed',
      mintUrl,
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(100),
      unit: 'sat',
      quoteId,
      request: 'lnbc100',
      expiry: null,
      outputData: { keep: [], send: [] },
      createdAt: 1_000,
      updatedAt: 2_000,
      error: 'expired',
    } as FailedMintOperation;
  }

  function makePreparedReceiveOperation(id: string): PreparedReceiveOperation {
    return {
      id,
      state: 'prepared',
      mintUrl,
      unit: 'sat',
      amount: Amount.from(42),
      fee: Amount.from(1),
      outputData: { keep: [], send: [] },
      inputProofs: receiveProofs,
      source: {
        type: 'payment-request',
        requestOperationId: 'request-op-1',
        requestId: 'request-1',
        attemptId: 'attempt-1',
        transport: 'nostr',
        transportMessageId: 'message-1',
        senderPubkey: 'sender-1',
        memo: 'memo-1',
      },
      createdAt: 1_000,
      updatedAt: 2_000,
    };
  }
});
