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
  MintQuoteRow,
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
type HistoryVisibleMeltState = Exclude<MeltOperationRow['state'], 'init'>;

const stores = [
  'coco_cashu_send_operations',
  'coco_cashu_melt_operations',
  'coco_cashu_mint_operations',
  'coco_cashu_canonical_mint_quotes',
  'coco_cashu_receive_operations',
  'coco_cashu_history',
] as const;

const historyVisibleMeltStates = new Set<HistoryVisibleMeltState>([
  'prepared',
  'executing',
  'pending',
  'finalized',
  'rolling_back',
  'rolled_back',
]);

function isHistoryVisibleMeltState(state: string): state is HistoryVisibleMeltState {
  return historyVisibleMeltStates.has(state as HistoryVisibleMeltState);
}

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

function parseReceiveSourceMetadata(
  sourceJson: string | null | undefined,
): Record<string, string> | undefined {
  if (!sourceJson) return undefined;

  const source = JSON.parse(sourceJson) as Record<string, unknown>;
  if (
    source.type !== 'payment-request' ||
    typeof source.requestOperationId !== 'string' ||
    typeof source.attemptId !== 'string' ||
    typeof source.transport !== 'string'
  ) {
    return undefined;
  }

  return {
    source: 'payment-request',
    requestOperationId: source.requestOperationId,
    attemptId: source.attemptId,
    ...(typeof source.requestId === 'string' ? { requestId: source.requestId } : {}),
    transport: source.transport,
    ...(typeof source.transportMessageId === 'string'
      ? { transportMessageId: source.transportMessageId }
      : {}),
    ...(typeof source.senderPubkey === 'string' ? { senderPubkey: source.senderPubkey } : {}),
    ...(typeof source.memo === 'string' ? { memo: source.memo } : {}),
  };
}

export class IdbHistoryRepository implements HistoryRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const pageWindow = offset + limit;
    if (pageWindow <= 0) return [];

    const entries = await this.db.runTransaction('r', [...stores], async (tx) => {
      const [sendRows, meltRows, mintRows, receiveRows, legacyRows] = await Promise.all([
        this.readRecentOperationRows<SendOperationRow>(
          tx.table('coco_cashu_send_operations'),
          pageWindow,
          'send',
        ),
        this.readRecentOperationRows<MeltOperationRow>(
          tx.table('coco_cashu_melt_operations'),
          pageWindow,
          'melt',
        ),
        this.readRecentOperationRows<MintOperationRow>(
          tx.table('coco_cashu_mint_operations'),
          pageWindow,
          'mint',
        ),
        this.readRecentOperationRows<ReceiveOperationRow>(
          tx.table('coco_cashu_receive_operations'),
          pageWindow,
          'receive',
        ),
        this.readVisibleLegacyRows(tx, tx.table('coco_cashu_history'), pageWindow),
      ]);
      const mintRemoteStateByOperationId = await this.readMintRemoteStateByOperationId(
        tx,
        mintRows,
      );

      const operationEntries = [
        ...sendRows.map((row) => this.sendRowToEntry(row)).filter(Boolean),
        ...meltRows.map((row) => this.meltRowToEntry(row)).filter(Boolean),
        ...mintRows
          .map((row) => this.mintRowToEntry(row, mintRemoteStateByOperationId.get(row.id)))
          .filter(Boolean),
        ...receiveRows.map((row) => this.receiveRowToEntry(row)).filter(Boolean),
      ] as HistoryEntry[];

      return [...operationEntries, ...legacyRows].sort(compareHistoryEntries);
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
          if (!row) return null;
          const quote = await this.getMintQuoteRowForOperation(tx, row);
          return this.mintRowToEntry(row, quote?.lastObservedRemoteState ?? undefined);
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

  private async readRecentOperationRows<TRow extends OperationRow & { createdAt: number }>(
    table: Table,
    limit: number,
    type: LegacyHistoryRow['type'],
  ): Promise<TRow[]> {
    return (await table
      .orderBy('createdAt')
      .reverse()
      .filter((row) => this.operationIsHistoryEligible(type, row as OperationRow))
      .limit(limit)
      .toArray()) as TRow[];
  }

  private async readRecentRows<TRow extends { createdAt: number }>(
    table: Table,
    offset: number,
    limit: number,
  ): Promise<TRow[]> {
    return (await table
      .orderBy('createdAt')
      .reverse()
      .offset(offset)
      .limit(limit)
      .toArray()) as TRow[];
  }

  private async readMintRemoteStateByOperationId(
    tx: { table(name: string): Table },
    rows: MintOperationRow[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    await Promise.all(
      rows.map(async (row) => {
        const quote = await this.getMintQuoteRowForOperation(tx, row);
        if (quote?.lastObservedRemoteState) {
          result.set(row.id, quote.lastObservedRemoteState);
        }
      }),
    );
    return result;
  }

  private async getMintQuoteRowForOperation(
    tx: { table(name: string): Table },
    row: MintOperationRow,
  ): Promise<MintQuoteRow | undefined> {
    if (!row.quoteId) return undefined;
    return (await tx
      .table('coco_cashu_canonical_mint_quotes')
      .get([row.mintUrl, row.method, row.quoteId])) as MintQuoteRow | undefined;
  }

  private async readVisibleLegacyRows(
    tx: { table(name: string): Table },
    table: Table,
    limit: number,
  ): Promise<LegacyHistoryEntry[]> {
    const entries: LegacyHistoryEntry[] = [];
    const batchSize = Math.max(limit, 50);
    let offset = 0;

    while (entries.length < limit) {
      const rows = await this.readRecentRows<LegacyHistoryRow>(table, offset, batchSize);
      if (rows.length === 0) break;

      for (const row of rows) {
        if (await this.legacyIsDeduped(tx, row)) continue;
        entries.push(this.legacyRowToEntry(row));
        if (entries.length >= limit) break;
      }

      if (rows.length < batchSize) break;
      offset += rows.length;
    }

    return entries;
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
      unit: row.unit ?? token?.unit ?? 'sat',
      operationId: row.id,
      amount: deserializeAmount(row.amount),
      state: row.state,
      ...(row.error ? { error: row.error } : {}),
      ...(token ? { token } : {}),
    };
  }

  private meltRowToEntry(row: MeltOperationRow): HistoryEntry | null {
    if (!isHistoryVisibleMeltState(row.state)) return null;
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

  private mintRowToEntry(row: MintOperationRow, remoteState?: string): HistoryEntry | null {
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
      ...(remoteState ? { remoteState } : {}),
      ...(row.error ? { error: row.error } : {}),
    };
  }

  private receiveRowToEntry(row: ReceiveOperationRow): HistoryEntry | null {
    if (row.state !== 'finalized' && row.state !== 'rolled_back') return null;
    const metadata = parseReceiveSourceMetadata(row.sourceJson);
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
      ...(metadata ? { metadata } : {}),
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
      case 'mint':
        return row.state !== 'init';
      case 'melt':
        return isHistoryVisibleMeltState(row.state);
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
