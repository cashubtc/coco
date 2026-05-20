import type { Table } from 'dexie';
import type {
  HistoryEntry,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  ReceiveHistoryState,
  SendHistoryEntry,
  SendHistoryState,
} from '@cashu/coco-core';
import { deserializeAmount, deserializeToken, serializeAmount } from '@cashu/coco-core';
import type { IdbDb } from '../lib/db.ts';

type MintQuoteState = MintHistoryEntry['state'];
type MeltQuoteState = MeltHistoryEntry['state'];
type SendToken = NonNullable<SendHistoryEntry['token']>;
type ReceiveToken = NonNullable<ReceiveHistoryEntry['token']>;

type HistoryRow = {
  id?: number;
  mintUrl: string;
  type: HistoryEntry['type'];
  unit: string;
  amount: string;
  createdAt: number;
  metadata?: Record<string, string> | null;
  quoteId?: string | null;
  operationId?: string | null;
  state?: string;
  paymentRequest?: string;
  tokenJson?: string | null;
};

type NewHistoryEntry =
  | Omit<MintHistoryEntry, 'id'>
  | Omit<MeltHistoryEntry, 'id'>
  | Omit<SendHistoryEntry, 'id'>
  | Omit<ReceiveHistoryEntry, 'id'>;

type UpdatableHistoryEntry =
  | Omit<MintHistoryEntry, 'id' | 'createdAt'>
  | Omit<MeltHistoryEntry, 'id' | 'createdAt'>
  | Omit<SendHistoryEntry, 'id' | 'createdAt'>
  | Omit<ReceiveHistoryEntry, 'id' | 'createdAt'>;

function parseToken<TToken>(tokenJson: string | null | undefined): TToken | undefined {
  return tokenJson ? (deserializeToken(JSON.parse(tokenJson)) as TToken | undefined) : undefined;
}

export class IdbHistoryRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const coll = this.historyTable();
    const rows = await coll.orderBy('createdAt').reverse().offset(offset).limit(limit).toArray();
    return rows.map((r) => this.rowToEntry(r));
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const row = await this.historyTable().get(Number(id));
    if (!row) return null;
    return this.rowToEntry(row);
  }

  async addHistoryEntry(history: NewHistoryEntry): Promise<HistoryEntry> {
    const row = this.entryToRow(history);
    const table = this.historyTable();
    const id = (await table.add(row)) as number;
    const stored = await table.get(id);
    if (!stored) {
      throw new Error('History entry not found after insert');
    }
    return this.rowToEntry(stored);
  }

  async getMintHistoryEntry(mintUrl: string, quoteId: string): Promise<MintHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+quoteId+type]')
      .equals([mintUrl, quoteId, 'mint'])
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'mint' ? entry : null;
  }

  async getMeltHistoryEntry(mintUrl: string, quoteId: string): Promise<MeltHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+quoteId+type]')
      .equals([mintUrl, quoteId, 'melt'])
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'melt' ? entry : null;
  }

  async getMintHistoryEntryByOperationId(
    mintUrl: string,
    operationId: string,
  ): Promise<MintHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+operationId]')
      .equals([mintUrl, operationId])
      .filter((r) => r.type === 'mint')
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'mint' ? entry : null;
  }

  async getMeltHistoryEntryByOperationId(
    mintUrl: string,
    operationId: string,
  ): Promise<MeltHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+operationId]')
      .equals([mintUrl, operationId])
      .filter((r) => r.type === 'melt')
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'melt' ? entry : null;
  }

  async getSendHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<SendHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+operationId]')
      .equals([mintUrl, operationId])
      .last();
    if (!row || row.type !== 'send') return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'send' ? entry : null;
  }

  async getReceiveHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<ReceiveHistoryEntry | null> {
    const row = await this.historyTable()
      .where('[mintUrl+operationId]')
      .equals([mintUrl, operationId])
      .last();
    if (!row || row.type !== 'receive') return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'receive' ? entry : null;
  }

  async updateHistoryEntry(history: UpdatableHistoryEntry): Promise<HistoryEntry> {
    const coll = this.historyTable();

    if (history.type === 'mint') {
      const rows = history.operationId
        ? await coll
            .where('[mintUrl+operationId]')
            .equals([history.mintUrl, history.operationId])
            .filter((r) => r.type === 'mint')
            .toArray()
        : await coll
            .where('[mintUrl+quoteId+type]')
            .equals([history.mintUrl, history.quoteId, 'mint'])
            .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1]!;
      const updated = {
        ...row,
        unit: history.unit,
        amount: serializeAmount(history.amount),
        metadata: history.metadata ?? null,
        operationId: history.operationId ?? null,
        state: history.state,
        paymentRequest: history.paymentRequest,
      };
      const id = this.rowId(row);
      await coll.update(id, updated);
      const fresh = await coll.get(id);
      if (!fresh) throw new Error('History entry not found after update');
      return this.rowToEntry(fresh);
    } else if (history.type === 'melt') {
      const rows = history.operationId
        ? await coll
            .where('[mintUrl+operationId]')
            .equals([history.mintUrl, history.operationId])
            .filter((r) => r.type === 'melt')
            .toArray()
        : await coll
            .where('[mintUrl+quoteId+type]')
            .equals([history.mintUrl, history.quoteId, 'melt'])
            .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1]!;
      const updated = {
        ...row,
        unit: history.unit,
        amount: serializeAmount(history.amount),
        metadata: history.metadata ?? null,
        operationId: history.operationId ?? null,
        state: history.state,
      };
      const id = this.rowId(row);
      await coll.update(id, updated);
      const fresh = await coll.get(id);
      if (!fresh) throw new Error('History entry not found after update');
      return this.rowToEntry(fresh);
    } else if (history.type === 'send') {
      const rows = await coll
        .where('[mintUrl+operationId]')
        .equals([history.mintUrl, history.operationId])
        .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1]!;
      const updated = {
        ...row,
        unit: history.unit,
        amount: serializeAmount(history.amount),
        metadata: history.metadata ?? null,
        state: history.state,
        tokenJson: history.token ? JSON.stringify(history.token) : row.tokenJson,
      };
      const id = this.rowId(row);
      await coll.update(id, updated);
      const fresh = await coll.get(id);
      if (!fresh) throw new Error('History entry not found after update');
      return this.rowToEntry(fresh);
    } else if (history.type === 'receive') {
      if (!history.operationId) {
        throw new Error('History entry operation id is required');
      }
      const rows = await coll
        .where('[mintUrl+operationId]')
        .equals([history.mintUrl, history.operationId])
        .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1]!;
      const updated = {
        ...row,
        unit: history.unit,
        amount: serializeAmount(history.amount),
        metadata: history.metadata ?? null,
        state: history.state,
        tokenJson: history.token ? JSON.stringify(history.token as ReceiveToken) : row.tokenJson,
      };
      const id = this.rowId(row);
      await coll.update(id, updated);
      const fresh = await coll.get(id);
      if (!fresh) throw new Error('History entry not found after update');
      return this.rowToEntry(fresh);
    } else {
      throw new Error(`Unsupported history entry type: ${String((history as HistoryEntry).type)}`);
    }
  }

  async updateSendHistoryState(
    mintUrl: string,
    operationId: string,
    state: SendHistoryState,
  ): Promise<void> {
    const coll = this.historyTable();
    const rows = await coll.where('[mintUrl+operationId]').equals([mintUrl, operationId]).toArray();
    if (!rows.length) return;
    const row = rows[rows.length - 1]!;
    await coll.update(this.rowId(row), { state });
  }

  async updateReceiveHistoryState(
    mintUrl: string,
    operationId: string,
    state: ReceiveHistoryState,
  ): Promise<void> {
    const coll = this.historyTable();
    const rows = await coll.where('[mintUrl+operationId]').equals([mintUrl, operationId]).toArray();
    if (!rows.length) return;
    const row = rows[rows.length - 1]!;
    await coll.update(this.rowId(row), { state });
  }

  async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
    const coll = this.historyTable();
    const rows = await coll
      .where('[mintUrl+quoteId+type]')
      .between([mintUrl, quoteId, ''], [mintUrl, quoteId, ''])
      .toArray();
    const ids = rows.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    await coll.bulkDelete(ids);
  }

  private historyTable(): Table<HistoryRow, number> {
    return this.db.table('coco_cashu_history') as Table<HistoryRow, number>;
  }

  private rowId(row: HistoryRow): number {
    if (row.id === undefined) {
      throw new Error('History row is missing id');
    }
    return row.id;
  }

  private entryToRow(history: NewHistoryEntry): Omit<HistoryRow, 'id'> {
    const base: Omit<HistoryRow, 'id'> = {
      mintUrl: history.mintUrl,
      type: history.type,
      unit: history.unit,
      amount: serializeAmount(history.amount),
      createdAt: history.createdAt,
      metadata: history.metadata ?? null,
    };
    if (history.type === 'mint') {
      base.quoteId = history.quoteId;
      base.operationId = history.operationId ?? null;
      base.state = history.state as MintQuoteState;
      base.paymentRequest = history.paymentRequest;
    } else if (history.type === 'melt') {
      base.quoteId = history.quoteId;
      base.operationId = history.operationId ?? null;
      base.state = history.state as MeltQuoteState;
    } else if (history.type === 'send') {
      base.tokenJson = history.token ? JSON.stringify(history.token as SendToken) : null;
      base.operationId = history.operationId;
      base.state = history.state;
    } else if (history.type === 'receive') {
      base.tokenJson = history.token ? JSON.stringify(history.token as ReceiveToken) : null;
      base.operationId = history.operationId ?? null;
      base.state = history.state;
    }
    return base;
  }

  private rowToEntry(row: HistoryRow): HistoryEntry {
    const base = {
      id: String(row.id),
      createdAt: row.createdAt,
      mintUrl: row.mintUrl,
      unit: row.unit,
      metadata: row.metadata ?? undefined,
    } as const;
    if (row.type === 'mint') {
      return {
        ...base,
        type: 'mint',
        paymentRequest: row.paymentRequest ?? '',
        quoteId: row.quoteId ?? '',
        operationId: row.operationId ?? undefined,
        state: (row.state ?? 'UNPAID') as MintQuoteState,
        amount: deserializeAmount(row.amount),
      };
    }
    if (row.type === 'melt') {
      return {
        ...base,
        type: 'melt',
        quoteId: row.quoteId ?? '',
        operationId: row.operationId ?? undefined,
        state: (row.state ?? 'UNPAID') as MeltQuoteState,
        amount: deserializeAmount(row.amount),
      };
    }
    if (row.type === 'send') {
      return {
        ...base,
        type: 'send',
        amount: deserializeAmount(row.amount),
        operationId: row.operationId ?? '',
        state: (row.state ?? 'pending') as SendHistoryState,
        token: parseToken<SendToken>(row.tokenJson),
      };
    }
    const token = parseToken<ReceiveToken>(row.tokenJson);
    return {
      ...base,
      type: 'receive',
      amount: deserializeAmount(row.amount),
      operationId: row.operationId ?? undefined,
      state: (row.state ?? 'finalized') as ReceiveHistoryState,
      token,
    } satisfies HistoryEntry;
  }
}
