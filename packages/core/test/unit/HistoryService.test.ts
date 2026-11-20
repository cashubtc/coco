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
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationRepository } from '../../operations/mintSwap/MintSwapOperationRepository.ts';
import { projectMintSwapHistoryEntry } from '../../repositories/MintSwapHistoryProjection.ts';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';

describe('HistoryService', () => {
  let service: HistoryService;
  let eventBus: EventBus<CoreEvents>;
  let historyUpdateEvents: Array<{ mintUrl: string; entry: HistoryEntry }>;
  let repositoryEntries: Map<string, HistoryEntry>;
  let linkedParents: Map<string, MintSwapOperation>;
  let quoteParent: MintSwapOperation | null;
  let childLookupError: Error | null;
  let quoteLookupError: Error | null;
  let historyLookupError: Error | null;
  let quoteLookups: Array<{
    kind: 'mint' | 'melt';
    quote: Parameters<MintSwapOperationRepository['getByQuote']>[1];
  }>;

  const mintUrl = 'https://mint.test';
  const receiveProofs = [{ id: 'keyset-1', amount: Amount.from(42), secret: 'secret-1', C: 'C-1' }];

  beforeEach(() => {
    repositoryEntries = new Map();
    linkedParents = new Map();
    quoteParent = null;
    childLookupError = null;
    quoteLookupError = null;
    historyLookupError = null;
    quoteLookups = [];
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
        if (historyLookupError) throw historyLookupError;
        return repositoryEntries.get(id) ?? null;
      },
    };

    const mintSwapOperationRepository = {
      async getByChild(kind: 'mint' | 'melt', operationId: string) {
        if (childLookupError) throw childLookupError;
        return linkedParents.get(`${kind}:${operationId}`) ?? null;
      },
      async getByQuote(
        kind: 'mint' | 'melt',
        quote: Parameters<MintSwapOperationRepository['getByQuote']>[1],
      ) {
        quoteLookups.push({ kind, quote });
        if (quoteLookupError) throw quoteLookupError;
        return quoteParent;
      },
    } as MintSwapOperationRepository;

    service = new HistoryService(historyRepository, mintSwapOperationRepository, eventBus);
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

  it('rereads and emits the grouped row for parent hints', async () => {
    const parent = mintSwapFixtures('hinted').prepared;
    const entry = projectMintSwapHistoryEntry(parent, null, null);
    repositoryEntries.set(entry.id, entry);

    await eventBus.emit('mint-swap:updated', {
      operationId: parent.id,
      revision: parent.revision,
      state: parent.state,
    });

    expect(historyUpdateEvents).toEqual([{ mintUrl: parent.destinationMintUrl, entry }]);
  });

  it('emits a stopped grouped parent instead of its exact child row', async () => {
    const parent = mintSwapFixtures('stopped').needs_attention;
    const child = makePreparedMeltOperation(parent.sourceOperationId, 'source-quote');
    const entry = projectMintSwapHistoryEntry(parent, child, null);
    repositoryEntries.set(entry.id, entry);
    linkedParents.set(`melt:${child.id}`, parent);

    await eventBus.emit('melt-op:prepared', {
      mintUrl: child.mintUrl,
      operationId: child.id,
      operation: child,
    });

    expect(historyUpdateEvents).toHaveLength(1);
    expect(historyUpdateEvents[0]).toEqual({ mintUrl: parent.destinationMintUrl, entry });
    expect(historyUpdateEvents[0]?.entry.id).not.toBe(`melt:${child.id}`);
  });

  it('falls back to child projections when an adapter has no grouped parent row', async () => {
    const parent = mintSwapFixtures('adapter-fallback').prepared;
    const source = makePreparedMeltOperation(parent.sourceOperationId, 'source-quote');
    const destination = makeFailedMintOperation(parent.destinationOperationId, 'destination-quote');
    linkedParents.set(`melt:${source.id}`, parent);
    linkedParents.set(`mint:${destination.id}`, parent);

    await eventBus.emit('melt-op:prepared', {
      mintUrl: source.mintUrl,
      operationId: source.id,
      operation: source,
    });
    await eventBus.emit('mint-op:failed', {
      mintUrl: destination.mintUrl,
      operationId: destination.id,
      operation: destination,
    });

    expect(historyUpdateEvents.map(({ entry }) => entry.id)).toEqual([
      `melt:${source.id}`,
      `mint:${destination.id}`,
    ]);
  });

  it('uses the quote reverse lookup before emitting a child after an ID lookup failure', async () => {
    const source = makePreparedMeltOperation('ordinary-source', 'ordinary-quote');
    childLookupError = new Error('child index unavailable');

    await eventBus.emit('melt-op:prepared', {
      mintUrl: source.mintUrl,
      operationId: source.id,
      operation: source,
    });

    expect(quoteLookups).toEqual([
      {
        kind: 'melt',
        quote: { mintUrl: source.mintUrl, method: source.method, quoteId: source.quoteId },
      },
    ]);
    expect(historyUpdateEvents.map(({ entry }) => entry.id)).toEqual([`melt:${source.id}`]);
  });

  it('emits the grouped parent when quote lookup recovers a failed child lookup', async () => {
    const parent = mintSwapFixtures('quote-fallback').prepared;
    const source = {
      ...makePreparedMeltOperation(parent.sourceOperationId, parent.sourceQuote.quoteId),
      mintUrl: parent.sourceMintUrl,
    };
    const entry = projectMintSwapHistoryEntry(parent, source, null);
    repositoryEntries.set(entry.id, entry);
    childLookupError = new Error('child index unavailable');
    quoteParent = parent;

    await eventBus.emit('melt-op:prepared', {
      mintUrl: source.mintUrl,
      operationId: source.id,
      operation: source,
    });

    expect(historyUpdateEvents).toEqual([{ mintUrl: parent.destinationMintUrl, entry }]);
  });

  it('does not guess child ownership when both reverse lookups fail', async () => {
    const source = makePreparedMeltOperation('unknown-source', 'unknown-quote');
    childLookupError = new Error('child index unavailable');
    quoteLookupError = new Error('quote index unavailable');

    await eventBus.emit('melt-op:prepared', {
      mintUrl: source.mintUrl,
      operationId: source.id,
      operation: source,
    });

    expect(historyUpdateEvents).toHaveLength(0);
  });

  it('does not emit a known parent child when the grouped projection fails', async () => {
    const parent = mintSwapFixtures('projection-failure').prepared;
    const source = makePreparedMeltOperation(parent.sourceOperationId, parent.sourceQuote.quoteId);
    linkedParents.set(`melt:${source.id}`, parent);
    historyLookupError = new Error('grouped projection unavailable');

    await eventBus.emit('melt-op:prepared', {
      mintUrl: source.mintUrl,
      operationId: source.id,
      operation: source,
    });

    expect(quoteLookups).toHaveLength(0);
    expect(historyUpdateEvents).toHaveLength(0);
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

  it('reads paginated history and individual entries through the projection repository', async () => {
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
    await expect(service.getHistoryEntryById(entry.id)).resolves.toEqual(entry);
  });

  it('returns legacy send entries without an operation id', async () => {
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

    await expect(service.getHistoryEntryById(legacy.id)).resolves.toEqual(legacy);
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
