import { describe, it, beforeEach, expect } from 'bun:test';
import { HistoryService } from '../../services/HistoryService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { HistoryRepository } from '../../repositories';
import type { HistoryEntry, MeltHistoryEntry, MintHistoryEntry } from '../../models/History';
import type {
  FinalizedMeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  RolledBackMeltOperation,
} from '../../operations/melt';
import type { PendingMintOperation } from '../../operations/mint';

describe('HistoryService', () => {
  let service: HistoryService;
  let mockRepo: HistoryRepository;
  let eventBus: EventBus<CoreEvents>;
  let historyEntries: Map<string, HistoryEntry>;
  let historyUpdateEvents: Array<{ mintUrl: string; entry: HistoryEntry }>;

  const makePendingOperation = (
    quoteId: string,
    overrides: Partial<PendingMintOperation> = {},
  ): PendingMintOperation =>
    ({
      id: `mint-op-${quoteId}`,
      state: 'pending',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: {},
      amount: 1000,
      unit: 'sat',
      quoteId,
      request: `request-${quoteId}`,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      outputData: { keep: [], send: [] },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastObservedRemoteState: 'UNPAID',
      lastObservedRemoteStateAt: Date.now(),
      ...overrides,
    }) as PendingMintOperation;

  const makePreparedMeltOperation = (
    quoteId: string,
    overrides: Partial<PreparedMeltOperation> = {},
  ): PreparedMeltOperation =>
    ({
      id: `melt-op-${quoteId}`,
      state: 'prepared',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: { invoice: `lnbc-${quoteId}` },
      amount: 900,
      unit: 'sat',
      fee_reserve: 10,
      quoteId,
      swap_fee: 0,
      inputAmount: 910,
      inputProofSecrets: ['proof-secret-1'],
      changeOutputData: { keep: [], send: [] },
      needsSwap: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }) as PreparedMeltOperation;

  const makePendingMeltOperation = (
    quoteId: string,
    overrides: Partial<PendingMeltOperation> = {},
  ): PendingMeltOperation =>
    ({
      ...makePreparedMeltOperation(quoteId),
      state: 'pending',
      ...overrides,
    }) as PendingMeltOperation;

  const makeFinalizedMeltOperation = (
    quoteId: string,
    overrides: Partial<FinalizedMeltOperation> = {},
  ): FinalizedMeltOperation =>
    ({
      ...makePreparedMeltOperation(quoteId),
      state: 'finalized',
      changeAmount: 0,
      effectiveFee: 10,
      ...overrides,
    }) as FinalizedMeltOperation;

  const makeRolledBackMeltOperation = (
    quoteId: string,
    overrides: Partial<RolledBackMeltOperation> = {},
  ): RolledBackMeltOperation =>
    ({
      ...makePreparedMeltOperation(quoteId),
      state: 'rolled_back',
      error: 'Rolled back',
      ...overrides,
    }) as RolledBackMeltOperation;

  beforeEach(() => {
    historyEntries = new Map();
    historyUpdateEvents = [];

    mockRepo = {
      async addHistoryEntry(entry: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry> {
        const id = Math.random().toString(36).substring(7);
        const fullEntry = { ...entry, id } as HistoryEntry;
        historyEntries.set(id, fullEntry);
        return fullEntry;
      },
      async getMintHistoryEntry(
        mintUrl: string,
        quoteId: string,
      ): Promise<MintHistoryEntry | null> {
        for (const entry of historyEntries.values()) {
          if (entry.type === 'mint' && entry.mintUrl === mintUrl && entry.quoteId === quoteId) {
            return entry as MintHistoryEntry;
          }
        }
        return null;
      },
      async getMeltHistoryEntry(
        mintUrl: string,
        quoteId: string,
      ): Promise<MeltHistoryEntry | null> {
        for (const entry of historyEntries.values()) {
          if (entry.type === 'melt' && entry.mintUrl === mintUrl && entry.quoteId === quoteId) {
            return entry as MeltHistoryEntry;
          }
        }
        return null;
      },
      async getPaginatedHistoryEntries(): Promise<HistoryEntry[]> {
        return Array.from(historyEntries.values());
      },
      async getSendHistoryEntry(): Promise<null> {
        return null;
      },
      async getReceiveHistoryEntry(): Promise<null> {
        return null;
      },
      async updateHistoryEntryState(): Promise<void> {},
      async getHistoryEntryById(): Promise<null> {
        return null;
      },
      async updateHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry> {
        historyEntries.set(entry.id, entry);
        return entry;
      },
      async updateSendHistoryState(): Promise<void> {},
      async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
        for (const [id, entry] of historyEntries.entries()) {
          if (
            (entry.type === 'mint' || entry.type === 'melt') &&
            entry.mintUrl === mintUrl &&
            entry.quoteId === quoteId
          ) {
            historyEntries.delete(id);
          }
        }
      },
    } as HistoryRepository;

    eventBus = new EventBus<CoreEvents>();
    eventBus.on('history:updated', (payload) => {
      historyUpdateEvents.push(payload);
    });

    service = new HistoryService(mockRepo, eventBus);
  });

  describe('mint operations', () => {
    it('creates history entry for mint-op:pending', async () => {
      const operation = makePendingOperation('pending-quote', {
        amount: 1000,
        request: 'lnbc1000...',
        lastObservedRemoteState: 'UNPAID',
      });

      await eventBus.emit('mint-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.type).toBe('mint');
      expect(entry.mintUrl).toBe(operation.mintUrl);
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.state).toBe('UNPAID');
      expect(entry.unit).toBe(operation.unit);
      expect(entry.paymentRequest).toBe(operation.request);
      expect(historyUpdateEvents.length).toBe(1);
    });

    it('updates existing history entry on mint-op:quote-state-changed', async () => {
      const operation = makePendingOperation('stateful-quote', {
        amount: 500,
        request: 'lnbc500...',
        lastObservedRemoteState: 'UNPAID',
      });

      await mockRepo.addHistoryEntry({
        type: 'mint',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: operation.amount,
        state: 'UNPAID',
        unit: operation.unit,
        paymentRequest: operation.request,
        createdAt: operation.createdAt,
      } as Omit<MintHistoryEntry, 'id'>);

      await eventBus.emit('mint-op:quote-state-changed', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
        quoteId: operation.quoteId,
        state: 'PAID',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.state).toBe('PAID');
      expect(historyUpdateEvents.length).toBe(1);
      expect(historyUpdateEvents[0]?.entry.type).toBe('mint');
    });

    it('updates an existing history entry instead of creating a duplicate pending entry', async () => {
      const operation = makePendingOperation('existing-quote', {
        amount: 750,
        request: 'lnbc750...',
        lastObservedRemoteState: 'PAID',
      });

      await mockRepo.addHistoryEntry({
        type: 'mint',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: 10,
        state: 'UNPAID',
        unit: operation.unit,
        paymentRequest: 'old-request',
        createdAt: operation.createdAt,
      } as Omit<MintHistoryEntry, 'id'>);

      await eventBus.emit('mint-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.amount).toBe(operation.amount);
      expect(entry.paymentRequest).toBe(operation.request);
      expect(entry.state).toBe('PAID');
      expect(historyUpdateEvents.length).toBe(1);
    });
  });

  describe('melt operations', () => {
    it('creates history entry for melt-op:prepared', async () => {
      const operation = makePreparedMeltOperation('melt-prepared', { amount: 250 });

      await eventBus.emit('melt-op:prepared', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.type).toBe('melt');
      expect(entry.mintUrl).toBe(operation.mintUrl);
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.state).toBe('UNPAID');
      expect(entry.unit).toBe('sat');
      expect(historyUpdateEvents.length).toBe(1);
    });

    it('preserves non-sat unit when creating melt history from an operation event', async () => {
      const operation = makePreparedMeltOperation('melt-usd', {
        amount: 250,
        unit: 'usd',
      });

      await eventBus.emit('melt-op:prepared', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.unit).toBe('usd');
    });

    it('updates an existing melt history entry on melt-op:pending', async () => {
      const operation = makePendingMeltOperation('melt-pending', { amount: 275 });

      await mockRepo.addHistoryEntry({
        type: 'melt',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: 100,
        state: 'UNPAID',
        unit: 'sat',
        createdAt: operation.createdAt,
      } as Omit<MeltHistoryEntry, 'id'>);

      await eventBus.emit('melt-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.amount).toBe(operation.amount);
      expect(entry.state).toBe('PENDING');
      expect(historyUpdateEvents.length).toBe(1);
      expect(historyUpdateEvents[0]?.entry.type).toBe('melt');
    });

    it('preserves an existing non-sat unit when the operation payload omits it', async () => {
      const operation = makePendingMeltOperation('melt-pending-usd', {
        amount: 275,
        unit: undefined as unknown as string,
      });

      await mockRepo.addHistoryEntry({
        type: 'melt',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: 100,
        state: 'UNPAID',
        unit: 'usd',
        createdAt: operation.createdAt,
      } as Omit<MeltHistoryEntry, 'id'>);

      await eventBus.emit('melt-op:pending', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.unit).toBe('usd');
    });

    it('creates history entry for immediate melt-op:finalized results', async () => {
      const operation = makeFinalizedMeltOperation('melt-finalized', { amount: 300 });

      await eventBus.emit('melt-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.state).toBe('PAID');
      expect(historyUpdateEvents.length).toBe(1);
    });

    it('updates melt history entries to UNPAID on melt-op:rolled-back and emits an update', async () => {
      const operation = makeRolledBackMeltOperation('melt-rolled-back', { amount: 325 });

      await mockRepo.addHistoryEntry({
        type: 'melt',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: operation.amount,
        state: 'PENDING',
        unit: 'sat',
        createdAt: operation.createdAt,
      } as Omit<MeltHistoryEntry, 'id'>);

      await eventBus.emit('melt-op:rolled-back', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.state).toBe('UNPAID');
      expect(historyUpdateEvents.length).toBe(1);
      expect(historyUpdateEvents[0]?.entry.type).toBe('melt');
      expect((historyUpdateEvents[0]?.entry as MeltHistoryEntry).quoteId).toBe(operation.quoteId);
      expect((historyUpdateEvents[0]?.entry as MeltHistoryEntry).state).toBe('UNPAID');
    });

    it('does not remove mint history entries that share a quoteId with a rolled back melt', async () => {
      const operation = makeRolledBackMeltOperation('shared-quote-id', { amount: 325 });

      await mockRepo.addHistoryEntry({
        type: 'mint',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: 500,
        state: 'PAID',
        unit: 'sat',
        paymentRequest: 'lnbc500...',
        createdAt: operation.createdAt - 1,
      } as Omit<MintHistoryEntry, 'id'>);

      await mockRepo.addHistoryEntry({
        type: 'melt',
        mintUrl: operation.mintUrl,
        quoteId: operation.quoteId,
        amount: operation.amount,
        state: 'UNPAID',
        unit: 'sat',
        createdAt: operation.createdAt,
      } as Omit<MeltHistoryEntry, 'id'>);

      await eventBus.emit('melt-op:rolled-back', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation,
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(historyEntries.size).toBe(2);

      const mintEntry = Array.from(historyEntries.values()).find(
        (entry): entry is MintHistoryEntry => entry.type === 'mint',
      );
      const meltEntry = Array.from(historyEntries.values()).find(
        (entry): entry is MeltHistoryEntry => entry.type === 'melt',
      );

      expect(mintEntry).not.toBeUndefined();
      expect(mintEntry?.quoteId).toBe(operation.quoteId);
      expect(mintEntry?.state).toBe('PAID');

      expect(meltEntry).not.toBeUndefined();
      expect(meltEntry?.quoteId).toBe(operation.quoteId);
      expect(meltEntry?.state).toBe('UNPAID');

      expect(historyUpdateEvents.length).toBe(1);
      expect(historyUpdateEvents[0]?.entry.type).toBe('melt');
    });
  });
});
