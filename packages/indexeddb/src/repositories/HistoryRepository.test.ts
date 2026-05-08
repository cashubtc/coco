/// <reference types="bun" />

// @ts-ignore bun:test types are provided by the test runner in this workspace.
import { describe, expect, it } from 'bun:test';
import { IdbHistoryRepository } from './HistoryRepository.ts';
import type { ReceiveOperationRow, SendOperationRow } from '../lib/db.ts';

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

  async get(id: string): Promise<TRow | undefined> {
    return this.rows.find((row) => (row as { id?: string }).id === id);
  }

  orderBy(field: 'createdAt'): FakeCollection<TRow> {
    return new FakeCollection([...this.rows].sort((a, b) => a[field] - b[field]));
  }
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
        coco_cashu_send_operations: [makeSendRow('send-dedup', 1)],
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

function makeSendRow(id: string, createdAt: number): SendOperationRow {
  return {
    id,
    mintUrl: 'https://mint.test',
    amount: '1',
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
