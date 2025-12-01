import type { MintQuoteState, MeltQuoteState, Token } from '@cashu/cashu-ts';
import type { Table } from 'dexie';
import type {
  HistoryEntry,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  SendHistoryEntry,
  SendHistoryState,
} from 'coco-cashu-core';
import type { IdbDb } from '../lib/db.ts';

type NewHistoryEntry =
  | Omit<MintHistoryEntry, 'id'>
  | Omit<MeltHistoryEntry, 'id'>
  | Omit<SendHistoryEntry, 'id'>
  | Omit<ReceiveHistoryEntry, 'id'>;

type UpdatableHistoryEntry =
  | Omit<MintHistoryEntry, 'id' | 'createdAt'>
  | Omit<MeltHistoryEntry, 'id' | 'createdAt'>
  | Omit<SendHistoryEntry, 'id' | 'createdAt'>;

export class IdbHistoryRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const coll = this.db.table('coco_cashu_history') as Table<any, number>;
    const rows = await coll.orderBy('createdAt').reverse().offset(offset).limit(limit).toArray();
    return rows.map((r: any) => this.rowToEntry(r));
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const row = await (this.db as any).table('coco_cashu_history').get(Number(id));
    if (!row) return null;
    return this.rowToEntry(row);
  }

  async addHistoryEntry(history: NewHistoryEntry): Promise<HistoryEntry> {
    const row = this.entryToRow(history);
    const id = (await (this.db as any).table('coco_cashu_history').add(row)) as number;
    const stored = await (this.db as any).table('coco_cashu_history').get(id);
    return this.rowToEntry(stored);
  }

  async getMintHistoryEntry(mintUrl: string, quoteId: string): Promise<MintHistoryEntry | null> {
    const row = await (this.db as any)
      .table('coco_cashu_history')
      .where('[mintUrl+quoteId+type]')
      .equals([mintUrl, quoteId, 'mint'])
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'mint' ? entry : null;
  }

  async getMeltHistoryEntry(mintUrl: string, quoteId: string): Promise<MeltHistoryEntry | null> {
    const row = await (this.db as any)
      .table('coco_cashu_history')
      .where('[mintUrl+quoteId+type]')
      .equals([mintUrl, quoteId, 'melt'])
      .last();
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'melt' ? entry : null;
  }

  async getSendHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<SendHistoryEntry | null> {
    const row = await (this.db as any)
      .table('coco_cashu_history')
      .where('[mintUrl+operationId]')
      .equals([mintUrl, operationId])
      .last();
    if (!row || row.type !== 'send') return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'send' ? entry : null;
  }

  async updateHistoryEntry(history: UpdatableHistoryEntry): Promise<HistoryEntry> {
    const coll = (this.db as any).table('coco_cashu_history');

    if (history.type === 'mint') {
      const rows = await coll
        .where('[mintUrl+quoteId+type]')
        .equals([history.mintUrl, history.quoteId, 'mint'])
        .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1];
      const updated = {
        ...row,
        unit: history.unit,
        amount: history.amount,
        metadata: history.metadata ?? null,
        state: history.state,
        paymentRequest: history.paymentRequest,
      };
      await coll.update(row.id, updated);
      const fresh = await coll.get(row.id);
      return this.rowToEntry(fresh);
    } else if (history.type === 'melt') {
      const rows = await coll
        .where('[mintUrl+quoteId+type]')
        .equals([history.mintUrl, history.quoteId, 'melt'])
        .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1];
      const updated = {
        ...row,
        unit: history.unit,
        amount: history.amount,
        metadata: history.metadata ?? null,
        state: history.state,
      };
      await coll.update(row.id, updated);
      const fresh = await coll.get(row.id);
      return this.rowToEntry(fresh);
    } else if (history.type === 'send') {
      const rows = await coll
        .where('[mintUrl+operationId]')
        .equals([history.mintUrl, history.operationId])
        .toArray();
      if (!rows.length) throw new Error('History entry not found');
      const row = rows[rows.length - 1];
      const updated = {
        ...row,
        unit: history.unit,
        amount: history.amount,
        metadata: history.metadata ?? null,
        state: history.state,
        tokenJson: history.token ? JSON.stringify(history.token) : row.tokenJson,
      };
      await coll.update(row.id, updated);
      const fresh = await coll.get(row.id);
      return this.rowToEntry(fresh);
    } else {
      throw new Error('updateHistoryEntry does not support receive entries');
    }
  }

  async updateSendHistoryState(
    mintUrl: string,
    operationId: string,
    state: SendHistoryState,
  ): Promise<void> {
    const coll = (this.db as any).table('coco_cashu_history');
    const rows = await coll.where('[mintUrl+operationId]').equals([mintUrl, operationId]).toArray();
    if (!rows.length) return;
    const row = rows[rows.length - 1];
    await coll.update(row.id, { state });
  }

  async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
    const coll = (this.db as any).table('coco_cashu_history');
    const rows = await coll
      .where('[mintUrl+quoteId+type]')
      .between([mintUrl, quoteId, ''], [mintUrl, quoteId, ''])
      .toArray();
    const ids = rows.map((r: any) => r.id);
    await coll.bulkDelete(ids);
  }

  private entryToRow(history: NewHistoryEntry): any {
    const base = {
      mintUrl: history.mintUrl,
      type: history.type,
      unit: history.unit,
      amount: history.amount,
      createdAt: history.createdAt,
      metadata: history.metadata ?? null,
    } as any;
    if (history.type === 'mint') {
      base.quoteId = history.quoteId;
      base.state = history.state as MintQuoteState;
      base.paymentRequest = history.paymentRequest;
    } else if (history.type === 'melt') {
      base.quoteId = history.quoteId;
      base.state = history.state as MeltQuoteState;
    } else if (history.type === 'send') {
      base.tokenJson = history.token ? JSON.stringify(history.token as Token) : null;
      base.operationId = history.operationId;
      base.state = history.state;
    }
    return base;
  }

  private rowToEntry(row: any): HistoryEntry {
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
        state: (row.state ?? 'UNPAID') as MintQuoteState,
        amount: row.amount,
      };
    }
    if (row.type === 'melt') {
      return {
        ...base,
        type: 'melt',
        quoteId: row.quoteId ?? '',
        state: (row.state ?? 'UNPAID') as MeltQuoteState,
        amount: row.amount,
      };
    }
    if (row.type === 'send') {
      return {
        ...base,
        type: 'send',
        amount: row.amount,
        operationId: row.operationId ?? '',
        state: (row.state ?? 'pending') as SendHistoryState,
        token: row.tokenJson ? (JSON.parse(row.tokenJson) as Token) : undefined,
      };
    }
    return { ...base, type: 'receive', amount: row.amount } as HistoryEntry;
  }
}
