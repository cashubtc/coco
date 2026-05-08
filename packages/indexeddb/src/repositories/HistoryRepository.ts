import type { Table } from 'dexie';
import type {
  HistoryEntry,
  HistoryRepository,
  LegacyHistoryEntry,
  LegacyHistoryRowInput,
} from '@cashu/coco-core';
import type { Token } from '@cashu/cashu-ts';
import {
  compareHistoryEntries,
  deserializeAmount,
  deserializeToken,
  operationHistoryId,
  parseHistoryEntryId,
  projectLegacyHistoryRow,
} from '@cashu/coco-core';
import type {
  IdbDb,
  MeltOperationRow,
  MintOperationRow,
  ReceiveOperationRow,
  SendOperationRow,
} from '../lib/db.ts';

type LegacyHistoryRow = {
  id: number;
  mintUrl: string;
  type: 'mint' | 'melt' | 'send' | 'receive';
  unit: string;
  amount: string | number;
  createdAt: number;
  quoteId?: string | null;
  state?: string | null;
  paymentRequest?: string | null;
  tokenJson?: string | null;
  metadata?: Record<string, string> | null;
  operationId?: string | null;
};

type OperationRow = SendOperationRow | MeltOperationRow | MintOperationRow | ReceiveOperationRow;

const stores = [
  'coco_cashu_send_operations',
  'coco_cashu_melt_operations',
  'coco_cashu_mint_operations',
  'coco_cashu_receive_operations',
  'coco_cashu_history',
] as const;

function parseToken(tokenJson: string | null | undefined): Token | undefined {
  return tokenJson ? deserializeToken(JSON.parse(tokenJson)) : undefined;
}

function parseReceiveProofs(
  inputProofsJson: string | null | undefined,
): NonNullable<Extract<HistoryEntry, { type: 'receive' }>['token']>['proofs'] {
  const proofs = inputProofsJson ? JSON.parse(inputProofsJson) : [];
  return proofs.map((proof: { amount: string | number }) => ({
    ...proof,
    amount: deserializeAmount(proof.amount),
  }));
}

export class IdbHistoryRepository implements HistoryRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const pageWindow = offset + limit;
    const entries = await this.db.runTransaction('r', [...stores], async (tx) => {
      const [sendRows, meltRows, mintRows, receiveRows, legacyRows] = await Promise.all([
        this.readRecentRows<SendOperationRow>(tx.table('coco_cashu_send_operations'), pageWindow),
        this.readRecentRows<MeltOperationRow>(tx.table('coco_cashu_melt_operations'), pageWindow),
        this.readRecentRows<MintOperationRow>(tx.table('coco_cashu_mint_operations'), pageWindow),
        this.readRecentRows<ReceiveOperationRow>(
          tx.table('coco_cashu_receive_operations'),
          pageWindow,
        ),
        this.readRecentRows<LegacyHistoryRow>(tx.table('coco_cashu_history'), pageWindow),
      ]);

      const operationEntries = [
        ...sendRows.map((row) => this.sendRowToEntry(row)).filter(Boolean),
        ...meltRows.map((row) => this.meltRowToEntry(row)).filter(Boolean),
        ...mintRows.map((row) => this.mintRowToEntry(row)).filter(Boolean),
        ...receiveRows.map((row) => this.receiveRowToEntry(row)).filter(Boolean),
      ] as HistoryEntry[];

      const legacyEntries = await this.visibleLegacyEntries(tx, legacyRows);
      return [...operationEntries, ...legacyEntries].sort(compareHistoryEntries);
    });

    return entries.slice(offset, offset + limit);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const parsed = parseHistoryEntryId(id);
    if (!parsed) return null;

    return this.db.runTransaction('r', [...stores], async (tx) => {
      if (parsed.source === 'legacy') {
        const row = (await tx.table('coco_cashu_history').get(Number(parsed.legacyHistoryId))) as
          | LegacyHistoryRow
          | undefined;
        if (!row || (await this.legacyIsDeduped(tx, row))) return null;
        return this.legacyRowToEntry(row);
      }

      switch (parsed.type) {
        case 'send': {
          const row = (await tx.table('coco_cashu_send_operations').get(parsed.operationId)) as
            | SendOperationRow
            | undefined;
          return row ? this.sendRowToEntry(row) : null;
        }
        case 'melt': {
          const row = (await tx.table('coco_cashu_melt_operations').get(parsed.operationId)) as
            | MeltOperationRow
            | undefined;
          return row ? this.meltRowToEntry(row) : null;
        }
        case 'mint': {
          const row = (await tx.table('coco_cashu_mint_operations').get(parsed.operationId)) as
            | MintOperationRow
            | undefined;
          return row ? this.mintRowToEntry(row) : null;
        }
        case 'receive': {
          const row = (await tx.table('coco_cashu_receive_operations').get(parsed.operationId)) as
            | ReceiveOperationRow
            | undefined;
          return row ? this.receiveRowToEntry(row) : null;
        }
      }
    });
  }

  private async readRecentRows<TRow extends { createdAt: number }>(
    table: Table,
    limit: number,
  ): Promise<TRow[]> {
    return (await table.orderBy('createdAt').reverse().limit(limit).toArray()) as TRow[];
  }

  private sendRowToEntry(row: SendOperationRow): HistoryEntry | null {
    if (row.state === 'init') return null;
    const token = parseToken(row.tokenJson);
    return {
      id: operationHistoryId('send', row.id),
      source: 'operation',
      type: 'send',
      createdAt: row.createdAt * 1000,
      updatedAt: row.updatedAt * 1000,
      mintUrl: row.mintUrl,
      unit: token?.unit ?? 'sat',
      operationId: row.id,
      amount: deserializeAmount(row.amount),
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      ...(token ? { token } : {}),
    };
  }

  private meltRowToEntry(row: MeltOperationRow): HistoryEntry | null {
    if (row.state === 'init') return null;
    return {
      id: operationHistoryId('melt', row.id),
      source: 'operation',
      type: 'melt',
      createdAt: row.createdAt * 1000,
      updatedAt: row.updatedAt * 1000,
      mintUrl: row.mintUrl,
      unit: row.unit ?? 'sat',
      operationId: row.id,
      quoteId: row.quoteId ?? '',
      amount: deserializeAmount(row.amount ?? 0),
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private mintRowToEntry(row: MintOperationRow): HistoryEntry | null {
    if (row.state === 'init') return null;
    return {
      id: operationHistoryId('mint', row.id),
      source: 'operation',
      type: 'mint',
      createdAt: row.createdAt * 1000,
      updatedAt: row.updatedAt * 1000,
      mintUrl: row.mintUrl,
      unit: row.unit ?? 'sat',
      operationId: row.id,
      quoteId: row.quoteId ?? '',
      paymentRequest: row.request ?? '',
      amount: deserializeAmount(row.amount ?? 0),
      state: row.state,
      ...(row.lastObservedRemoteState ? { remoteState: row.lastObservedRemoteState } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private receiveRowToEntry(row: ReceiveOperationRow): HistoryEntry | null {
    if (row.state !== 'finalized' && row.state !== 'rolled_back') return null;
    return {
      id: operationHistoryId('receive', row.id),
      source: 'operation',
      type: 'receive',
      createdAt: row.createdAt * 1000,
      updatedAt: row.updatedAt * 1000,
      mintUrl: row.mintUrl,
      unit: row.unit ?? 'sat',
      operationId: row.id,
      amount: deserializeAmount(row.amount),
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      ...(row.state === 'finalized'
        ? {
            token: {
              mint: row.mintUrl,
              proofs: parseReceiveProofs(row.inputProofsJson),
              unit: row.unit ?? 'sat',
            },
          }
        : {}),
    };
  }

  private async visibleLegacyEntries(
    tx: { table(name: string): Table },
    rows: LegacyHistoryRow[],
  ): Promise<LegacyHistoryEntry[]> {
    const entries: LegacyHistoryEntry[] = [];
    for (const row of rows) {
      if (await this.legacyIsDeduped(tx, row)) continue;
      entries.push(this.legacyRowToEntry(row));
    }
    return entries;
  }

  private legacyRowToEntry(row: LegacyHistoryRow): LegacyHistoryEntry {
    return projectLegacyHistoryRow(this.legacyRowToInput(row));
  }

  private legacyRowToInput(row: LegacyHistoryRow): LegacyHistoryRowInput {
    return {
      legacyHistoryId: row.id,
      type: row.type,
      createdAt: row.createdAt,
      mintUrl: row.mintUrl,
      unit: row.unit,
      amount: deserializeAmount(row.amount),
      quoteId: row.quoteId,
      state: row.state,
      paymentRequest: row.paymentRequest,
      token: parseToken(row.tokenJson),
      metadata: row.metadata ?? undefined,
      operationId: row.operationId,
    };
  }

  private async legacyIsDeduped(
    tx: { table(name: string): Table },
    row: LegacyHistoryRow,
  ): Promise<boolean> {
    if (row.operationId) {
      const operation = await this.getOperationRow(tx, row.type, row.operationId);
      if (operation && this.operationIsHistoryEligible(row.type, operation)) return true;
    }

    if (
      (row.type === 'mint' || row.type === 'melt') &&
      row.quoteId &&
      (await this.hasOperationForQuote(tx, row.type, row.mintUrl, row.quoteId))
    ) {
      return true;
    }

    return false;
  }

  private async getOperationRow(
    tx: { table(name: string): Table },
    type: LegacyHistoryRow['type'],
    operationId: string,
  ): Promise<OperationRow | undefined> {
    switch (type) {
      case 'send':
        return (await tx.table('coco_cashu_send_operations').get(operationId)) as
          | SendOperationRow
          | undefined;
      case 'melt':
        return (await tx.table('coco_cashu_melt_operations').get(operationId)) as
          | MeltOperationRow
          | undefined;
      case 'mint':
        return (await tx.table('coco_cashu_mint_operations').get(operationId)) as
          | MintOperationRow
          | undefined;
      case 'receive':
        return (await tx.table('coco_cashu_receive_operations').get(operationId)) as
          | ReceiveOperationRow
          | undefined;
    }
  }

  private operationIsHistoryEligible(type: LegacyHistoryRow['type'], row: OperationRow): boolean {
    switch (type) {
      case 'send':
      case 'melt':
      case 'mint':
        return row.state !== 'init';
      case 'receive':
        return row.state === 'finalized' || row.state === 'rolled_back';
    }
  }

  private async hasOperationForQuote(
    tx: { table(name: string): Table },
    type: 'mint' | 'melt',
    mintUrl: string,
    quoteId: string,
  ): Promise<boolean> {
    const store = type === 'mint' ? 'coco_cashu_mint_operations' : 'coco_cashu_melt_operations';
    const row = (await tx
      .table(store)
      .where('[mintUrl+quoteId]')
      .equals([mintUrl, quoteId])
      .first()) as OperationRow | undefined;
    return row ? this.operationIsHistoryEligible(type, row) : false;
  }
}
