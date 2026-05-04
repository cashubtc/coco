import type {
  HistoryEntry,
  HistoryRepository,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  ReceiveHistoryState,
  SendHistoryEntry,
  SendHistoryState,
} from '@cashu/coco-core';
import { deserializeAmount, serializeAmount } from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';

type MintQuoteState = MintHistoryEntry['state'];
type MeltQuoteState = MeltHistoryEntry['state'];
type ReceiveToken = NonNullable<ReceiveHistoryEntry['token']>;
type SendToken = NonNullable<SendHistoryEntry['token']>;

type Row = {
  id: number;
  mintUrl: string;
  type: 'mint' | 'melt' | 'send' | 'receive';
  unit: string;
  amount: string | number;
  createdAt: number;
  quoteId: string | null;
  state: string | null;
  paymentRequest: string | null;
  tokenJson: string | null;
  metadata: string | null;
  operationId: string | null;
};

export class SqliteHistoryRepository implements HistoryRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const rows = await this.db.all<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history
       ORDER BY createdAt DESC, id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((r) => this.rowToEntry(r));
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE id = ?`,
      [id],
    );
    if (!row) return null;
    return this.rowToEntry(row);
  }

  async addHistoryEntry(history: Omit<HistoryEntry, 'id'>): Promise<HistoryEntry> {
    const baseParams = [
      history.mintUrl,
      history.type,
      history.unit,
      serializeAmount(history.amount),
      history.createdAt,
    ];

    let quoteId: string | null = null;
    let state: string | null = null;
    let paymentRequest: string | null = null;
    let tokenJson: string | null = null;
    let metadata: string | null = history.metadata ? JSON.stringify(history.metadata) : null;
    let operationId: string | null = null;

    switch (history.type) {
      case 'mint': {
        const h = history as Omit<MintHistoryEntry, 'id'>;
        quoteId = h.quoteId;
        state = h.state;
        paymentRequest = h.paymentRequest;
        operationId = h.operationId ?? null;
        break;
      }
      case 'melt': {
        const h = history as Omit<MeltHistoryEntry, 'id'>;
        quoteId = h.quoteId;
        state = h.state;
        operationId = h.operationId ?? null;
        break;
      }
      case 'send': {
        const h = history as Omit<SendHistoryEntry, 'id'>;
        tokenJson = h.token ? JSON.stringify(h.token as SendToken) : null;
        operationId = h.operationId;
        state = h.state;
        break;
      }
      case 'receive': {
        const h = history as Omit<ReceiveHistoryEntry, 'id'>;
        tokenJson = h.token ? JSON.stringify(h.token as ReceiveToken) : null;
        operationId = h.operationId ?? null;
        state = h.state;
        break;
      }
    }

    const result = await this.db.run(
      `INSERT INTO coco_cashu_history (mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...baseParams, quoteId, state, paymentRequest, tokenJson, metadata, operationId],
    );
    const id = result.lastID;
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE id = ?`,
      [id],
    );
    if (!row) throw new Error('History insert failed to return row');
    return this.rowToEntry(row);
  }

  async getMintHistoryEntry(mintUrl: string, quoteId: string): Promise<MintHistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
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
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'melt' ? entry : null;
  }

  async getSendHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<SendHistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = 'send'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, operationId],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'send' ? entry : null;
  }

  async getReceiveHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<ReceiveHistoryEntry | null> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = 'receive'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, operationId],
    );
    if (!row) return null;
    const entry = this.rowToEntry(row);
    return entry.type === 'receive' ? entry : null;
  }

  async updateHistoryEntry(history: Omit<HistoryEntry, 'id' | 'createdAt'>): Promise<HistoryEntry> {
    let state: string | null = null;
    let paymentRequest: string | null = null;
    let tokenJson: string | null = null;

    if (history.type === 'mint') {
      const h = history as Omit<MintHistoryEntry, 'id' | 'createdAt'>;
      if (!h.quoteId) throw new Error('quoteId required for mint entry');
      state = h.state;
      paymentRequest = h.paymentRequest;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, paymentRequest = ?, metadata = ?
            , operationId = ?
         WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'`,
        [
          history.unit,
          serializeAmount(history.amount),
          state,
          paymentRequest,
          history.metadata ? JSON.stringify(history.metadata) : null,
          h.operationId ?? null,
          history.mintUrl,
          h.quoteId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, h.quoteId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else if (history.type === 'melt') {
      const h = history as Omit<MeltHistoryEntry, 'id' | 'createdAt'>;
      if (!h.quoteId) throw new Error('quoteId required for melt entry');
      state = h.state;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, metadata = ?, operationId = ?
         WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'`,
        [
          history.unit,
          serializeAmount(history.amount),
          state,
          history.metadata ? JSON.stringify(history.metadata) : null,
          h.operationId ?? null,
          history.mintUrl,
          h.quoteId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, h.quoteId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else if (history.type === 'send') {
      const h = history as Omit<SendHistoryEntry, 'id' | 'createdAt'>;
      if (!h.operationId) throw new Error('operationId required for send entry');
      state = h.state;
      tokenJson = h.token ? JSON.stringify(h.token as SendToken) : null;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, tokenJson = ?, metadata = ?
         WHERE mintUrl = ? AND operationId = ? AND type = 'send'`,
        [
          history.unit,
          serializeAmount(history.amount),
          state,
          tokenJson,
          history.metadata ? JSON.stringify(history.metadata) : null,
          history.mintUrl,
          h.operationId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = 'send'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, h.operationId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else if (history.type === 'receive') {
      const h = history as Omit<ReceiveHistoryEntry, 'id' | 'createdAt'>;
      if (!h.operationId) throw new Error('operationId required for receive entry');
      state = h.state;
      tokenJson = h.token ? JSON.stringify(h.token as ReceiveToken) : null;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, tokenJson = ?, metadata = ?
         WHERE mintUrl = ? AND operationId = ? AND type = 'receive'`,
        [
          history.unit,
          serializeAmount(history.amount),
          state,
          tokenJson,
          history.metadata ? JSON.stringify(history.metadata) : null,
          history.mintUrl,
          h.operationId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = 'receive'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, h.operationId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else {
      throw new Error(`Unsupported history entry type: ${String((history as HistoryEntry).type)}`);
    }
  }

  async updateSendHistoryState(
    mintUrl: string,
    operationId: string,
    state: SendHistoryState,
  ): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_history SET state = ?
       WHERE mintUrl = ? AND operationId = ? AND type = 'send'`,
      [state, mintUrl, operationId],
    );
  }

  async updateReceiveHistoryState(
    mintUrl: string,
    operationId: string,
    state: ReceiveHistoryState,
  ): Promise<void> {
    await this.db.run(
      `UPDATE coco_cashu_history SET state = ?
       WHERE mintUrl = ? AND operationId = ? AND type = 'receive'`,
      [state, mintUrl, operationId],
    );
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
        token: row.tokenJson ? (JSON.parse(row.tokenJson) as SendToken) : undefined,
      };
    }
    const token = row.tokenJson ? (JSON.parse(row.tokenJson) as ReceiveToken) : undefined;
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
