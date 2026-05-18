/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { IdbHistoryRepository } from './HistoryRepository.ts';
import type { MeltOperationRow, ReceiveOperationRow, SendOperationRow } from '../lib/db.ts';

type StoreRows = Record<string, unknown[]>;

class FakeCollection<TRow> {
  constructor(private readonly rows: TRow[]) {}

  reverse(): FakeCollection<TRow> {
    return new FakeCollection([...this.rows].reverse());
  }

  filter(predicate: (row: TRow) => boolean): FakeCollection<TRow> {
    return new FakeCollection(this.rows.filter(predicate));
  }

  offset(count: number): FakeCollection<TRow> {
    return new FakeCollection(this.rows.slice(count));
  }

  limit(count: number): FakeCollection<TRow> {
    return new FakeCollection(this.rows.slice(0, count));
  }

  async toArray(): Promise<TRow[]> {
    return this.rows;
  }
}

class FakeTable<TRow extends { createdAt: number }> {
  constructor(private readonly rows: TRow[]) {}

  async get(id: string | number): Promise<TRow | undefined> {
    return this.rows.find((row) => (row as { id?: string }).id === id);
  }

  orderBy(field: 'createdAt'): FakeCollection<TRow> {
    return new FakeCollection([...this.rows].sort((a, b) => a[field] - b[field]));
  }

  where(index: string) {
    return {
      equals: (value: unknown) => ({
        first: async (): Promise<TRow | undefined> => {
          return this.rows.find((row) => rowMatchesIndex(row, index, value));
        },
      }),
    };
  }
}

function rowMatchesIndex(row: unknown, index: string, value: unknown): boolean {
  if (index === '[mintUrl+quoteId]' && Array.isArray(value)) {
    const [mintUrl, quoteId] = value;
    const indexed = row as { mintUrl?: string; quoteId?: string | null };
    return indexed.mintUrl === mintUrl && indexed.quoteId === quoteId;
  }

  return (row as Record<string, unknown>)[index] === value;
}

function makeDb(stores: StoreRows) {
  const tx = {
    table(name: string) {
      return new FakeTable(stores[name] as { createdAt: number }[]);
    },
  };

  return {
    async runTransaction<T>(_mode: string, _stores: string[], fn: (txDb: typeof tx) => Promise<T>) {
      return fn(tx);
    },
  };
}

describe('IdbHistoryRepository', () => {
  it('filters operation rows before applying the per-store page window', async () => {
    const receiveRows: ReceiveOperationRow[] = [
      makeReceiveRow('receive-prepared-2', 'prepared', 4),
      makeReceiveRow('receive-prepared-1', 'prepared', 3),
      makeReceiveRow('receive-finalized', 'finalized', 2),
    ];
    const repository = new IdbHistoryRepository(
      makeDb({
        coco_cashu_send_operations: [],
        coco_cashu_melt_operations: [],
        coco_cashu_mint_operations: [],
        coco_cashu_receive_operations: receiveRows,
        coco_cashu_history: [],
      }) as never,
    );

    await expect(repository.getPaginatedHistoryEntries(1, 0)).resolves.toMatchObject([
      {
        id: 'receive:receive-finalized',
        type: 'receive',
        state: 'finalized',
      },
    ]);
  });

  it('over-scans legacy rows until it fills the visible page window', async () => {
    const repository = new IdbHistoryRepository(
      makeDb({
        coco_cashu_send_operations: [makeSendRow('send-dedup', 1, 'usd')],
        coco_cashu_melt_operations: [],
        coco_cashu_mint_operations: [],
        coco_cashu_receive_operations: [],
        coco_cashu_history: [
          {
            id: 1,
            mintUrl: 'https://mint.test',
            type: 'send',
            unit: 'sat',
            amount: '1',
            createdAt: 5_000,
            state: 'pending',
            operationId: 'send-dedup',
          },
          {
            id: 2,
            mintUrl: 'https://mint.test',
            type: 'send',
            unit: 'sat',
            amount: '2',
            createdAt: 4_000,
            state: 'pending',
            operationId: null,
          },
        ],
      }) as never,
    );

    await expect(repository.getPaginatedHistoryEntries(1, 0)).resolves.toMatchObject([
      {
        id: 'legacy:2',
        type: 'send',
        state: 'pending',
      },
    ]);
  });

  it('does not expose failed melt rows or use them to dedupe legacy rows', async () => {
    const repository = new IdbHistoryRepository(
      makeDb({
        coco_cashu_send_operations: [],
        coco_cashu_melt_operations: [makeMeltRow('melt-failed', 'failed', 5)],
        coco_cashu_mint_operations: [],
        coco_cashu_receive_operations: [],
        coco_cashu_history: [
          {
            id: 1,
            mintUrl: 'https://mint.test',
            type: 'melt',
            unit: 'sat',
            amount: '1',
            createdAt: 4_000,
            state: 'UNPAID',
            quoteId: 'quote-failed',
            operationId: null,
          },
        ],
      }) as never,
    );

    await expect(repository.getHistoryEntryById('melt:melt-failed')).resolves.toBeNull();
    await expect(repository.getPaginatedHistoryEntries(10, 0)).resolves.toMatchObject([
      {
        id: 'legacy:1',
        type: 'melt',
        state: 'UNPAID',
      },
    ]);
  });

  it('projects operation unit and payment-request receive metadata', async () => {
    const repository = new IdbHistoryRepository(
      makeDb({
        coco_cashu_send_operations: [makeSendRow('send-custom-unit', 5, 'usd')],
        coco_cashu_melt_operations: [],
        coco_cashu_mint_operations: [],
        coco_cashu_receive_operations: [
          {
            ...makeReceiveRow('receive-payment-request', 'finalized', 4),
            sourceJson: JSON.stringify({
              type: 'payment-request',
              requestOperationId: 'request-op-1',
              requestId: 'request-1',
              attemptId: 'attempt-1',
              transport: 'nostr',
              transportMessageId: 'message-1',
              senderPubkey: 'sender-1',
              memo: 'memo-1',
            }),
          },
        ],
        coco_cashu_history: [],
      }) as never,
    );

    await expect(repository.getPaginatedHistoryEntries(10, 0)).resolves.toMatchObject([
      {
        id: 'send:send-custom-unit',
        type: 'send',
        unit: 'usd',
      },
      {
        id: 'receive:receive-payment-request',
        type: 'receive',
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
      },
    ]);
  });
});

function makeReceiveRow(
  id: string,
  state: ReceiveOperationRow['state'],
  createdAt: number,
): ReceiveOperationRow {
  return {
    id,
    mintUrl: 'https://mint.test',
    unit: 'sat',
    amount: '1',
    state,
    createdAt,
    updatedAt: createdAt,
    error: null,
    fee: '0',
    inputProofsJson: '[]',
    outputDataJson: null,
  };
}

function makeSendRow(id: string, createdAt: number, unit = 'sat'): SendOperationRow {
  return {
    id,
    mintUrl: 'https://mint.test',
    amount: '1',
    unit,
    state: 'prepared',
    createdAt,
    updatedAt: createdAt,
    error: null,
    method: 'default',
    methodDataJson: '{}',
    needsSwap: 0,
    fee: '0',
    inputAmount: '1',
    inputProofSecretsJson: '[]',
    outputDataJson: null,
    tokenJson: null,
  };
}

function makeMeltRow(
  id: string,
  state: MeltOperationRow['state'] | 'failed',
  createdAt: number,
): MeltOperationRow {
  return {
    id,
    mintUrl: 'https://mint.test',
    state: state as MeltOperationRow['state'],
    createdAt,
    updatedAt: createdAt,
    error: 'failed',
    method: 'bolt11',
    methodDataJson: '{}',
    quoteId: 'quote-failed',
    unit: 'sat',
    amount: '1',
    fee_reserve: '0',
    swap_fee: '0',
    needsSwap: 0,
    inputAmount: '1',
    inputProofSecretsJson: '[]',
    changeOutputDataJson: '{"keep":[],"send":[]}',
    swapOutputDataJson: null,
    changeAmount: null,
    effectiveFee: null,
    finalizedDataJson: null,
  };
}
