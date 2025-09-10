import type { MintQuoteState, MeltQuoteState, Token } from '@cashu/cashu-ts';
import type {
  HistoryEntry,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  SendHistoryEntry,
} from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';

type Row = {
  id: number;
  mintUrl: string;
  type: 'mint' | 'melt' | 'send' | 'receive';
  unit: string;
  amount: number;
  createdAt: number;
  quoteId: string | null;
  state: string | null;
  paymentRequest: string | null;
  tokenJson: string | null;
  metadata: string | null;
};

type NewHistoryEntry =
  | Omit<MintHistoryEntry, 'id'>
  | Omit<MeltHistoryEntry, 'id'>
  | Omit<SendHistoryEntry, 'id'>
  | Omit<ReceiveHistoryEntry, 'id'>;

type UpdatableHistoryEntry =
  | Omit<MintHistoryEntry, 'id' | 'createdAt'>
  | Omit<MeltHistoryEntry, 'id' | 'createdAt'>;

export class SqliteHistoryRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const rows = await this.db.all<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history
       ORDER BY createdAt DESC, id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  async addHistoryEntry(history: NewHistoryEntry): Promise<HistoryEntry> {
    const baseParams = [
      history.mintUrl,
      history.type,
      history.unit,
      history.amount,
      history.createdAt,
    ];

    let quoteId: string | null = null;
    let state: string | null = null;
    let paymentRequest: string | null = null;
    let tokenJson: string | null = null;
    let metadata: string | null = history.metadata ? JSON.stringify(history.metadata) : null;

    switch (history.type) {
      case 'mint':
        quoteId = history.quoteId;
        state = history.state;
        paymentRequest = history.paymentRequest;
        break;
      case 'melt':
        quoteId = history.quoteId;
        state = history.state;
        break;
      case 'send':
        tokenJson = JSON.stringify(history.token satisfies Token);
        break;
      case 'receive':
        break;
    }

    const result = await this.db.run(
      `INSERT INTO coco_cashu_history (mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...baseParams, quoteId, state, paymentRequest, tokenJson, metadata],
    );
    const id = result.lastID;
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error('History insert failed to return row');
    return this.rowToEntry(row);
  }

  async getMintHistoryEntry(mintUrl: string, quoteId: string): Promise<MintHistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'mint' ? entry : null;
  }

  async getMeltHistoryEntry(mintUrl: string, quoteId: string): Promise<MeltHistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'melt' ? entry : null;
  }

  async updateHistoryEntry(history: UpdatableHistoryEntry): Promise<HistoryEntry> {
    const quoteId = history.quoteId;
    if (!quoteId) throw new Error('quoteId required');
    let state: string | null = null;
    let paymentRequest: string | null = null;
    if (history.type === 'mint') {
      state = history.state;
      paymentRequest = history.paymentRequest;
    } else {
      state = history.state;
    }

    await this.db.run(
      `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, paymentRequest = ?, metadata = ?
       WHERE mintUrl = ? AND quoteId = ? AND type = ?`,
      [
        history.unit,
        history.amount,
        state,
        paymentRequest,
        history.metadata ? JSON.stringify(history.metadata) : null,
        history.mintUrl,
        quoteId,
        history.type,
      ],
    );

    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = ?
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [history.mintUrl, quoteId, history.type],
    );
    if (!row) throw new Error('Updated history entry not found');
    return this.rowToEntry(row);
  }

  async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ?', [
      mintUrl,
      quoteId,
    ]);
  }

  private rowToEntry(row: Row): HistoryEntry {
    const base = {
      id: String(row.id),
      createdAt: row.createdAt,
      mintUrl: row.mintUrl,
      unit: row.unit,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
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
        token: row.tokenJson ? (JSON.parse(row.tokenJson) as Token) : ({} as Token),
      };
    }
    return {
      ...base,
      type: 'receive',
      amount: row.amount,
    } satisfies HistoryEntry;
  }
}
