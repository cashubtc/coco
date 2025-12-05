import type { MintQuoteState, MeltQuoteState, Token } from '@cashu/cashu-ts';
import { ExpoSqliteDb } from '../db.ts';

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
  operationId: string | null;
};

type BaseHistoryEntry = {
  id: string;
  createdAt: number;
  mintUrl: string;
  unit: string;
  metadata?: Record<string, string>;
};

export type MintHistoryEntry = BaseHistoryEntry & {
  type: 'mint';
  paymentRequest: string;
  quoteId: string;
  state: MintQuoteState;
  amount: number;
};

export type MeltHistoryEntry = BaseHistoryEntry & {
  type: 'melt';
  quoteId: string;
  state: MeltQuoteState;
  amount: number;
};

export type SendHistoryState = 'prepared' | 'pending' | 'finalized' | 'rolledBack';

export type SendHistoryEntry = BaseHistoryEntry & {
  type: 'send';
  amount: number;
  operationId: string;
  state: SendHistoryState;
  token?: Token;
};

export type ReceiveHistoryEntry = BaseHistoryEntry & {
  type: 'receive';
  amount: number;
};

export type HistoryEntry =
  | MintHistoryEntry
  | MeltHistoryEntry
  | SendHistoryEntry
  | ReceiveHistoryEntry;

type NewHistoryEntry =
  | Omit<MintHistoryEntry, 'id'>
  | Omit<MeltHistoryEntry, 'id'>
  | Omit<SendHistoryEntry, 'id'>
  | Omit<ReceiveHistoryEntry, 'id'>;

type UpdatableHistoryEntry =
  | Omit<MintHistoryEntry, 'id' | 'createdAt'>
  | Omit<MeltHistoryEntry, 'id' | 'createdAt'>
  | Omit<SendHistoryEntry, 'id' | 'createdAt'>;

export class ExpoHistoryRepository {
  private readonly db: ExpoSqliteDb;

  constructor(db: ExpoSqliteDb) {
    this.db = db;
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

  async addHistoryEntry(history: NewHistoryEntry): Promise<HistoryEntry> {
    const baseParams = [
      history.mintUrl,
      history.type,
      history.unit,
      history.amount,
      history.createdAt,
    ];

    // Defaults for nullable columns
    let quoteId: string | null = null;
    let state: string | null = null;
    let paymentRequest: string | null = null;
    let tokenJson: string | null = null;
    let metadata: string | null = history.metadata ? JSON.stringify(history.metadata) : null;
    let operationId: string | null = null;

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
        tokenJson = history.token ? JSON.stringify(history.token) : null;
        operationId = history.operationId;
        state = history.state;
        break;
      case 'receive':
        // no extra fields
        break;
    }

    const result = await this.db.run(
      `INSERT INTO coco_cashu_history (mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [...baseParams, quoteId, state, paymentRequest, tokenJson, metadata, operationId],
    );
    const id = result.lastID;
    return this.getById(id);
  }

  async updateHistoryMintEntry(
    mintUrl: string,
    quoteId: string,
    state: MintQuoteState,
  ): Promise<HistoryEntry> {
    await this.db.run(
      `UPDATE coco_cashu_history SET state = ? WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'`,
      [state, mintUrl, quoteId],
    );
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) throw new Error('Updated mint history entry not found');
    return this.rowToEntry(row);
  }

  async updateHistoryMeltEntry(
    mintUrl: string,
    quoteId: string,
    state: MeltQuoteState,
  ): Promise<HistoryEntry> {
    await this.db.run(
      `UPDATE coco_cashu_history SET state = ? WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'`,
      [state, mintUrl, quoteId],
    );
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata
       FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'
       ORDER BY createdAt DESC, id DESC LIMIT 1`,
      [mintUrl, quoteId],
    );
    if (!row) throw new Error('Updated melt history entry not found');
    return this.rowToEntry(row);
  }

  async updateHistoryEntry(history: UpdatableHistoryEntry): Promise<HistoryEntry> {
    let state: string | null = null;
    let paymentRequest: string | null = null;
    let tokenJson: string | null = null;

    if (history.type === 'mint') {
      if (!history.quoteId) throw new Error('quoteId required for mint entry');
      state = history.state;
      paymentRequest = history.paymentRequest;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, paymentRequest = ?, metadata = ?
         WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'`,
        [
          history.unit,
          history.amount,
          state,
          paymentRequest,
          history.metadata ? JSON.stringify(history.metadata) : null,
          history.mintUrl,
          history.quoteId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'mint'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, history.quoteId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else if (history.type === 'melt') {
      if (!history.quoteId) throw new Error('quoteId required for melt entry');
      state = history.state;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, metadata = ?
         WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'`,
        [
          history.unit,
          history.amount,
          state,
          history.metadata ? JSON.stringify(history.metadata) : null,
          history.mintUrl,
          history.quoteId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ? AND type = 'melt'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, history.quoteId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else if (history.type === 'send') {
      if (!history.operationId) throw new Error('operationId required for send entry');
      state = history.state;
      tokenJson = history.token ? JSON.stringify(history.token) : null;

      await this.db.run(
        `UPDATE coco_cashu_history SET unit = ?, amount = ?, state = ?, tokenJson = ?, metadata = ?
         WHERE mintUrl = ? AND operationId = ? AND type = 'send'`,
        [
          history.unit,
          history.amount,
          state,
          tokenJson,
          history.metadata ? JSON.stringify(history.metadata) : null,
          history.mintUrl,
          history.operationId,
        ],
      );

      const row = await this.db.get<Row>(
        `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
         FROM coco_cashu_history WHERE mintUrl = ? AND operationId = ? AND type = 'send'
         ORDER BY createdAt DESC, id DESC LIMIT 1`,
        [history.mintUrl, history.operationId],
      );
      if (!row) throw new Error('Updated history entry not found');
      return this.rowToEntry(row);
    } else {
      throw new Error('updateHistoryEntry does not support receive entries');
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

  async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_history WHERE mintUrl = ? AND quoteId = ?', [
      mintUrl,
      quoteId,
    ]);
  }

  private async getById(id: number): Promise<HistoryEntry> {
    const row = await this.db.get<Row>(
      `SELECT id, mintUrl, type, unit, amount, createdAt, quoteId, state, paymentRequest, tokenJson, metadata, operationId
       FROM coco_cashu_history WHERE id = ? LIMIT 1`,
      [id],
    );
    if (!row) throw new Error('History entry not found');
    return this.rowToEntry(row);
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
        operationId: row.operationId ?? '',
        state: (row.state ?? 'pending') as SendHistoryState,
        token: row.tokenJson ? (JSON.parse(row.tokenJson) as Token) : undefined,
      };
    }
    return {
      ...base,
      type: 'receive',
      amount: row.amount,
    } satisfies HistoryEntry;
  }
}
