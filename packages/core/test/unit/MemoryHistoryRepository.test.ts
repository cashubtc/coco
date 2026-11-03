import { Amount } from '@cashu/cashu-ts';
import { beforeEach, describe, expect, it } from 'bun:test';
import { MemoryHistoryRepository } from '../../repositories/memory/MemoryHistoryRepository';
import { MemoryMeltOperationRepository } from '../../repositories/memory/MemoryMeltOperationRepository';
import { MemoryMintOperationRepository } from '../../repositories/memory/MemoryMintOperationRepository';
import { MemoryMintSwapOperationRepository } from '../../repositories/memory/MemoryMintSwapOperationRepository.ts';
import { MemorySendOperationRepository } from '../../repositories/memory/MemorySendOperationRepository';
import type { PreparedMeltOperation } from '../../operations/melt';
import type { PendingMintOperation } from '../../operations/mint';
import type { PreparedSendOperation } from '../../operations/send/SendOperation';
import { mintSwapFixtures } from '../fixtures/MintSwap.ts';

describe('MemoryHistoryRepository', () => {
  let sendOperationRepository: MemorySendOperationRepository;
  let meltOperationRepository: MemoryMeltOperationRepository;
  let mintOperationRepository: MemoryMintOperationRepository;
  let mintSwapOperationRepository: MemoryMintSwapOperationRepository;
  let historyRepository: MemoryHistoryRepository;

  beforeEach(() => {
    sendOperationRepository = new MemorySendOperationRepository();
    meltOperationRepository = new MemoryMeltOperationRepository();
    mintOperationRepository = new MemoryMintOperationRepository();
    mintSwapOperationRepository = new MemoryMintSwapOperationRepository();
    historyRepository = new MemoryHistoryRepository({
      sendOperationRepository,
      meltOperationRepository,
      mintOperationRepository,
      mintSwapOperationRepository,
    });
  });

  it('projects operation-backed entries with deterministic ids and operation states', async () => {
    const send = makePreparedSendOperation('send-op-1', 2_000);
    const melt = makePreparedMeltOperation('melt-op-1', 'quote-1', 3_000);

    await sendOperationRepository.create(send);
    await meltOperationRepository.create(melt);

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history.map((entry) => entry.id)).toEqual(['melt:melt-op-1', 'send:send-op-1']);
    expect(history[0]).toMatchObject({
      source: 'operation',
      type: 'melt',
      state: 'prepared',
      operationId: 'melt-op-1',
    });
    expect(history[1]).toMatchObject({
      source: 'operation',
      type: 'send',
      state: 'prepared',
      operationId: 'send-op-1',
      unit: 'usd',
    });
  });

  it('keeps legacy rows visible when no operation-backed projection exists', async () => {
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 1,
      type: 'send',
      mintUrl: 'https://mint.test',
      unit: 'sat',
      amount: Amount.from(1),
      createdAt: 1_000,
      state: 'rolledBack',
    });

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      id: 'legacy:1',
      source: 'legacy',
      type: 'send',
      state: 'rolledBack',
      updatedAt: 1_000,
    });
  });

  it('preserves legacy null-state compatibility defaults', async () => {
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 1,
      type: 'send',
      mintUrl: 'https://mint.test',
      unit: 'sat',
      amount: Amount.from(1),
      createdAt: 1_000,
    });
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 2,
      type: 'receive',
      mintUrl: 'https://mint.test',
      unit: 'sat',
      amount: Amount.from(2),
      createdAt: 2_000,
    });

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history).toMatchObject([
      {
        id: 'legacy:2',
        type: 'receive',
        state: 'finalized',
      },
      {
        id: 'legacy:1',
        type: 'send',
        state: 'pending',
      },
    ]);
  });

  it('hides legacy rows with the same type and operationId as an operation projection', async () => {
    const send = makePreparedSendOperation('send-op-1', 2_000);
    await sendOperationRepository.create(send);
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 1,
      type: 'send',
      mintUrl: send.mintUrl,
      unit: 'sat',
      amount: send.amount,
      createdAt: 1_000,
      state: 'pending',
      operationId: send.id,
    });

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history.map((entry) => entry.id)).toEqual(['send:send-op-1']);
  });

  it('hides legacy mint and melt rows with the same mint and quote as an operation projection', async () => {
    const mint = makePendingMintOperation('mint-op-1', 'shared-quote', 4_000);
    const melt = makePreparedMeltOperation('melt-op-1', 'shared-quote', 3_000);

    await mintOperationRepository.create(mint);
    await meltOperationRepository.create(melt);
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 1,
      type: 'mint',
      mintUrl: mint.mintUrl,
      unit: mint.unit,
      amount: mint.amount,
      createdAt: 1_000,
      state: 'PAID',
      quoteId: mint.quoteId,
      paymentRequest: mint.request,
    });
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 2,
      type: 'melt',
      mintUrl: melt.mintUrl,
      unit: melt.unit,
      amount: melt.amount,
      createdAt: 1_500,
      state: 'UNPAID',
      quoteId: melt.quoteId,
    });

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history.map((entry) => entry.id)).toEqual(['mint:mint-op-1', 'melt:melt-op-1']);
  });

  it('groups a Mint Swap before pagination and preserves exact child direct lookup', async () => {
    const parent = mintSwapFixtures('grouped', 5_000).prepared;
    const source = makePreparedMeltOperation(parent.sourceOperationId, 'source-quote', 5_100);
    const destination = makePendingMintOperation(
      parent.destinationOperationId,
      'destination-quote',
      5_200,
    );
    await mintSwapOperationRepository.create(parent);
    await meltOperationRepository.create(source);
    await mintOperationRepository.create(destination);

    const history = await historyRepository.getPaginatedHistoryEntries(10, 0);

    expect(history.map((entry) => entry.id)).toEqual(['mint-swap:grouped']);
    expect(history[0]).toMatchObject({
      state: 'prepared',
      sourceChild: { operationId: source.id, present: true, state: 'prepared' },
      destinationChild: { operationId: destination.id, present: true, state: 'pending' },
    });
    expect(await historyRepository.getHistoryEntryById(`melt:${source.id}`)).toMatchObject({
      operationId: source.id,
    });
    expect(await historyRepository.getHistoryEntryById(`mint:${destination.id}`)).toMatchObject({
      operationId: destination.id,
    });
    expect(await historyRepository.getHistoryEntryById('mint-swap:grouped')).toEqual(history[0]!);
  });

  it('keeps terminal parents visible with missing children', async () => {
    const parent = mintSwapFixtures('terminal', 6_000).completed;
    await mintSwapOperationRepository.create(parent);

    expect(await historyRepository.getPaginatedHistoryEntries(10, 0)).toMatchObject([
      {
        id: 'mint-swap:terminal',
        state: 'completed',
        sourceChild: { operationId: parent.sourceOperationId, present: false },
        destinationChild: { operationId: parent.destinationOperationId, present: false },
      },
    ]);
  });

  it('deduplicates legacy children before suppressing the linked operation row', async () => {
    const parent = mintSwapFixtures('legacy', 7_000).prepared;
    const source = makePreparedMeltOperation(parent.sourceOperationId, 'source-quote', 7_100);
    await mintSwapOperationRepository.create(parent);
    await meltOperationRepository.create(source);
    await historyRepository.addLegacyHistoryEntry({
      legacyHistoryId: 3,
      type: 'melt',
      mintUrl: source.mintUrl,
      unit: source.unit,
      amount: source.amount,
      createdAt: 7_050,
      quoteId: source.quoteId,
      state: 'PAID',
    });

    expect(
      (await historyRepository.getPaginatedHistoryEntries(10, 0)).map((entry) => entry.id),
    ).toEqual(['mint-swap:legacy']);
  });

  function makePreparedSendOperation(id: string, createdAt: number): PreparedSendOperation {
    return {
      id,
      state: 'prepared',
      mintUrl: 'https://mint.test',
      amount: Amount.from(10),
      unit: 'usd',
      method: 'default',
      methodData: {},
      needsSwap: false,
      fee: Amount.from(0),
      inputAmount: Amount.from(10),
      inputProofSecrets: ['secret-1'],
      createdAt,
      updatedAt: createdAt,
    };
  }

  function makePreparedMeltOperation(
    id: string,
    quoteId: string,
    createdAt: number,
  ): PreparedMeltOperation {
    return {
      id,
      state: 'prepared',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: { invoice: `lnbc-${quoteId}` },
      unit: 'sat',
      amount: Amount.from(20),
      needsSwap: false,
      fee_reserve: Amount.from(1),
      quoteId,
      swap_fee: Amount.from(0),
      inputAmount: Amount.from(21),
      inputProofSecrets: ['secret-1'],
      changeOutputData: { keep: [], send: [] },
      createdAt,
      updatedAt: createdAt,
    };
  }

  function makePendingMintOperation(
    id: string,
    quoteId: string,
    createdAt: number,
  ): PendingMintOperation {
    return {
      id,
      state: 'pending',
      mintUrl: 'https://mint.test',
      method: 'bolt11',
      methodData: {},
      amount: Amount.from(30),
      unit: 'sat',
      quoteId,
      request: 'lnbc30',
      expiry: null,
      outputData: { keep: [], send: [] },
      createdAt,
      updatedAt: createdAt,
    };
  }
});
