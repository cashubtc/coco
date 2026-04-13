import type { Token } from '@cashu/cashu-ts';
import { describe, it, beforeEach, expect } from 'bun:test';
import { HistoryService } from '../../services/HistoryService';
import { EventBus } from '../../events/EventBus';
import type { CoreEvents } from '../../events/types';
import type { HistoryRepository } from '../../repositories';
import type {
  HistoryEntry,
  MeltHistoryEntry,
  MintHistoryEntry,
  ReceiveHistoryEntry,
  SendHistoryEntry,
} from '../../models/History';
import type {
  FinalizedMeltOperation,
  PendingMeltOperation,
  PreparedMeltOperation,
  RolledBackMeltOperation,
} from '../../operations/melt';
import type { PendingMintOperation } from '../../operations/mint';
import type {
  FinalizedReceiveOperation,
  PreparedReceiveOperation,
  RolledBackReceiveOperation,
} from '../../operations/receive/ReceiveOperation';

describe('HistoryService', () => {
  let service: HistoryService;
  let mockRepo: HistoryRepository;
  let eventBus: EventBus<CoreEvents>;
  let historyEntries: Map<string, HistoryEntry>;
  let historyUpdateEvents: Array<{ mintUrl: string; entry: HistoryEntry }>;
  const receiveToken = {
    mint: 'https://mint.test',
    unit: 'sat',
    proofs: [{ id: 'keyset-1', amount: 42, secret: 'secret-1', C: 'C-1' }],
  } as Token;
  const receiveProofs = receiveToken.proofs;
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

  const makePreparedReceiveOperation = (
    operationId: string,
    overrides: Partial<PreparedReceiveOperation> = {},
  ): PreparedReceiveOperation =>
    ({
      id: operationId,
      state: 'prepared',
      mintUrl: 'https://mint.test',
      unit: 'sat',
      amount: 42,
      fee: 1,
      outputData: { keep: [], send: [] },
      inputProofs: receiveProofs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    }) as PreparedReceiveOperation;

  const makeFinalizedReceiveOperation = (
    operationId: string,
    overrides: Partial<FinalizedReceiveOperation> = {},
  ): FinalizedReceiveOperation =>
    ({
      ...makePreparedReceiveOperation(operationId),
      state: 'finalized',
      ...overrides,
    }) as FinalizedReceiveOperation;

  const makeRolledBackReceiveOperation = (
    operationId: string,
    overrides: Partial<RolledBackReceiveOperation> = {},
  ): RolledBackReceiveOperation =>
    ({
      ...makePreparedReceiveOperation(operationId),
      state: 'rolled_back',
      error: 'Rolled back',
      ...overrides,
    }) as RolledBackReceiveOperation;

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
      async getSendHistoryEntry(
        mintUrl: string,
        operationId: string,
      ): Promise<SendHistoryEntry | null> {
        for (const entry of historyEntries.values()) {
          if (
            entry.type === 'send' &&
            entry.mintUrl === mintUrl &&
            entry.operationId === operationId
          ) {
            return entry;
          }
        }
        return null;
      },
      async getReceiveHistoryEntry(
        mintUrl: string,
        operationId: string,
      ): Promise<ReceiveHistoryEntry | null> {
        for (const entry of historyEntries.values()) {
          if (
            entry.type === 'receive' &&
            entry.mintUrl === mintUrl &&
            entry.operationId === operationId
          ) {
            return entry;
          }
        }
        return null;
      },
      async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
        return historyEntries.get(id) ?? null;
      },
      async updateHistoryEntry(entry: HistoryEntry): Promise<HistoryEntry> {
        historyEntries.set(entry.id, entry);
        return entry;
      },
      async updateSendHistoryState(): Promise<void> {},
      async updateReceiveHistoryState(): Promise<void> {},
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

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.type).toBe('mint');
      expect(entry.mintUrl).toBe(operation.mintUrl);
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.state).toBe('UNPAID');
      expect(entry.unit).toBe(operation.unit);
      expect(entry.paymentRequest).toBe(operation.request);
      expect(entry.operationId).toBe(operation.id);
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

      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.operationId).toBe(operation.id);
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

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MintHistoryEntry;
      expect(entry.amount).toBe(operation.amount);
      expect(entry.operationId).toBe(operation.id);
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

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.type).toBe('melt');
      expect(entry.mintUrl).toBe(operation.mintUrl);
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.operationId).toBe(operation.id);
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

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.amount).toBe(operation.amount);
      expect(entry.operationId).toBe(operation.id);
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

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as MeltHistoryEntry;
      expect(entry.quoteId).toBe(operation.quoteId);
      expect(entry.amount).toBe(operation.amount);
      expect(entry.operationId).toBe(operation.id);
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

  describe('receive operations', () => {
    it('creates receive history entry from receive-op:prepared', async () => {
      const operation = makePreparedReceiveOperation('receive-op-1');

      await eventBus.emit('receive-op:prepared', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: { ...operation, unit: 'usd' },
      });

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as ReceiveHistoryEntry;
      expect(entry.type).toBe('receive');
      expect(entry.amount).toBe(42);
      expect(entry.state).toBe('prepared');
      expect(entry.unit).toBe('usd');
      expect(entry.operationId).toBe(operation.id);
      expect(entry.token).toBeUndefined();
      expect(historyUpdateEvents.length).toBe(1);
    });

    it('finalizes prepared receive history via receive-op:finalized', async () => {
      const preparedOperation = makePreparedReceiveOperation('receive-op-2');
      const operation = makeFinalizedReceiveOperation('receive-op-2');

      await eventBus.emit('receive-op:prepared', {
        mintUrl: preparedOperation.mintUrl,
        operationId: preparedOperation.id,
        operation: { ...preparedOperation, unit: 'usd' },
      });
      await eventBus.emit('receive-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: { ...operation, unit: 'usd' },
      });

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as ReceiveHistoryEntry;
      expect(entry.state).toBe('finalized');
      expect(entry.unit).toBe('usd');
      expect(entry.operationId).toBe(operation.id);
      expect(entry.token).toEqual({
        mint: operation.mintUrl,
        proofs: operation.inputProofs,
        unit: 'usd',
      });
      expect(historyUpdateEvents.length).toBe(2);
    });

    it('enriches finalized receive history via receive:created', async () => {
      const operation = makeFinalizedReceiveOperation('receive-op-legacy');

      await eventBus.emit('receive-op:prepared', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: makePreparedReceiveOperation(operation.id, { unit: 'usd' }),
      });
      await eventBus.emit('receive-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: { ...operation, unit: 'usd' },
      });
      await eventBus.emit('receive:created', {
        mintUrl: operation.mintUrl,
        token: receiveToken,
        operationId: operation.id,
      });

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as ReceiveHistoryEntry;
      expect(entry.state).toBe('finalized');
      expect(entry.operationId).toBe(operation.id);
      expect(entry.unit).toBe('sat');
      expect(entry.token).toEqual(receiveToken);
      expect(historyUpdateEvents.length).toBe(3);
    });

    it('creates receive history entry from receive-op:rolled-back', async () => {
      const operation = makeRolledBackReceiveOperation('receive-op-3');

      await eventBus.emit('receive-op:rolled-back', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: { ...operation, unit: 'usd' },
      });

      expect(historyEntries.size).toBe(1);
      const entry = Array.from(historyEntries.values())[0] as ReceiveHistoryEntry;
      expect(entry.state).toBe('rolledBack');
      expect(entry.unit).toBe('usd');
      expect(entry.operationId).toBe(operation.id);
      expect(historyUpdateEvents.length).toBe(1);
    });

    it('keeps legacy receives without an operationId', async () => {
      await eventBus.emit('receive:created', {
        mintUrl: 'https://mint.test',
        token: receiveToken,
      });

      const entry = Array.from(historyEntries.values())[0] as ReceiveHistoryEntry;
      expect(entry.operationId).toBeUndefined();
      expect(entry.state).toBe('finalized');
      expect(entry.token).toEqual(receiveToken);
    });
  });
});
