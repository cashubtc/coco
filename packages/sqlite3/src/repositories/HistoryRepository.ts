import type {
  HistoryEntry,
  HistoryRepository,
  HistoryType,
  LegacyHistoryRowInput,
} from '@cashu/coco-core';
import type { Token } from '@cashu/cashu-ts';
import {
  deserializeAmount,
  deserializeToken,
  operationHistoryId,
  parseHistoryEntryId,
  projectLegacyHistoryRow,
} from '@cashu/coco-core';
import { SqliteDb } from '../db.ts';

type HistoryProjectionRow = {
  source: 'operation' | 'legacy';
  id: string;
  legacyHistoryId: string | null;
  type: HistoryType;
  mintUrl: string;
  unit: string | null;
  amount: string | number;
  createdAt: number;
  updatedAt: number;
  state: string;
  quoteId: string | null;
  paymentRequest: string | null;
  tokenJson: string | null;
  inputProofsJson: string | null;
  metadata: string | null;
  operationId: string | null;
  remoteState: string | null;
  error: string | null;
};

const projectionSelect = `
  SELECT *
  FROM (
    SELECT
      'operation' AS source,
      'send:' || id AS id,
      NULL AS legacyHistoryId,
      'send' AS type,
      mintUrl,
      COALESCE(unit, 'sat') AS unit,
      amount,
      createdAt * 1000 AS createdAt,
      updatedAt * 1000 AS updatedAt,
      state,
      NULL AS quoteId,
      NULL AS paymentRequest,
      tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      id AS operationId,
      NULL AS remoteState,
      error
    FROM coco_cashu_send_operations
    WHERE state != 'init'

    UNION ALL

    SELECT
      'operation' AS source,
      'melt:' || id AS id,
      NULL AS legacyHistoryId,
      'melt' AS type,
      mintUrl,
      COALESCE(unit, 'sat') AS unit,
      amount,
      createdAt * 1000 AS createdAt,
      updatedAt * 1000 AS updatedAt,
      state,
      quoteId,
      NULL AS paymentRequest,
      NULL AS tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      id AS operationId,
      NULL AS remoteState,
      error
    FROM coco_cashu_melt_operations
    WHERE state IN ('prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')

    UNION ALL

    SELECT
      'operation' AS source,
      'mint:' || id AS id,
      NULL AS legacyHistoryId,
      'mint' AS type,
      mintUrl,
      unit,
      amount,
      createdAt * 1000 AS createdAt,
      updatedAt * 1000 AS updatedAt,
      state,
      quoteId,
      request AS paymentRequest,
      NULL AS tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      id AS operationId,
      lastObservedRemoteState AS remoteState,
      error
    FROM coco_cashu_mint_operations
    WHERE state != 'init'

    UNION ALL

    SELECT
      'operation' AS source,
      'receive:' || id AS id,
      NULL AS legacyHistoryId,
      'receive' AS type,
      mintUrl,
      COALESCE(unit, 'sat') AS unit,
      amount,
      createdAt * 1000 AS createdAt,
      updatedAt * 1000 AS updatedAt,
      state,
      NULL AS quoteId,
      NULL AS paymentRequest,
      NULL AS tokenJson,
      inputProofsJson,
      sourceJson AS metadata,
      id AS operationId,
      NULL AS remoteState,
      error
    FROM coco_cashu_receive_operations
    WHERE state IN ('finalized', 'rolled_back')

    UNION ALL

    SELECT
      'legacy' AS source,
      'legacy:' || h.id AS id,
      CAST(h.id AS TEXT) AS legacyHistoryId,
      h.type,
      h.mintUrl,
      h.unit,
      h.amount,
      h.createdAt,
      h.createdAt AS updatedAt,
      COALESCE(h.state, '') AS state,
      h.quoteId,
      h.paymentRequest,
      h.tokenJson,
      NULL AS inputProofsJson,
      h.metadata,
      h.operationId,
      NULL AS remoteState,
      NULL AS error
    FROM coco_cashu_history h
    WHERE NOT (
      h.operationId IS NOT NULL AND EXISTS (
        SELECT 1 FROM (
          SELECT 'send' AS type, id AS operationId
          FROM coco_cashu_send_operations
          WHERE state != 'init'
          UNION ALL
          SELECT 'melt' AS type, id AS operationId
          FROM coco_cashu_melt_operations
          WHERE state IN (
            'prepared',
            'executing',
            'pending',
            'finalized',
            'rolling_back',
            'rolled_back'
          )
          UNION ALL
          SELECT 'mint' AS type, id AS operationId
          FROM coco_cashu_mint_operations
          WHERE state != 'init'
          UNION ALL
          SELECT 'receive' AS type, id AS operationId
          FROM coco_cashu_receive_operations
          WHERE state IN ('finalized', 'rolled_back')
        ) op
        WHERE op.type = h.type AND op.operationId = h.operationId
      )
    )
    AND NOT (
      h.operationId IS NULL
      AND h.type IN ('mint', 'melt')
      AND h.quoteId IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM (
          SELECT 'mint' AS type, mintUrl, quoteId
          FROM coco_cashu_mint_operations
          WHERE state != 'init'
          UNION ALL
          SELECT 'melt' AS type, mintUrl, quoteId
          FROM coco_cashu_melt_operations
          WHERE state IN (
            'prepared',
            'executing',
            'pending',
            'finalized',
            'rolling_back',
            'rolled_back'
          )
        ) opq
        WHERE opq.type = h.type AND opq.mintUrl = h.mintUrl AND opq.quoteId = h.quoteId
      )
    )
  )
`;

function parseToken(tokenJson: string | null): Token | undefined {
  return tokenJson ? deserializeToken(JSON.parse(tokenJson)) : undefined;
}

function parseMetadata(metadata: string | null): Record<string, string> | undefined {
  return metadata ? JSON.parse(metadata) : undefined;
}

function parseReceiveSourceMetadata(sourceJson: string | null): Record<string, string> | undefined {
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

export class SqliteHistoryRepository implements HistoryRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const rows = await this.db.all<HistoryProjectionRow>(
      `${projectionSelect}
       ORDER BY createdAt DESC, id DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );

    return rows.map(rowToEntry);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const parsed = parseHistoryEntryId(id);
    if (!parsed) return null;

    if (parsed.source === 'legacy') {
      const row = await this.db.get<HistoryProjectionRow>(
        `${projectionSelect}
         WHERE source = 'legacy' AND legacyHistoryId = ?
         LIMIT 1`,
        [parsed.legacyHistoryId],
      );
      return row ? rowToEntry(row) : null;
    }

    const row = await this.db.get<HistoryProjectionRow>(
      `${projectionSelect}
       WHERE source = 'operation' AND type = ? AND operationId = ?
       LIMIT 1`,
      [parsed.type, parsed.operationId],
    );
    return row ? rowToEntry(row) : null;
  }
}

function rowToEntry(row: HistoryProjectionRow): HistoryEntry {
  if (row.source === 'legacy') {
    return projectLegacyHistoryRow(rowToLegacyInput(row));
  }

  const base = {
    id: operationHistoryId(row.type, row.operationId ?? ''),
    source: 'operation' as const,
    type: row.type,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    mintUrl: row.mintUrl,
    unit: row.unit ?? 'sat',
    operationId: row.operationId ?? '',
    amount: deserializeAmount(row.amount),
    state: row.state,
    ...(row.error ? { error: row.error } : {}),
  };

  switch (row.type) {
    case 'mint':
      return {
        ...base,
        type: 'mint',
        quoteId: row.quoteId ?? '',
        paymentRequest: row.paymentRequest ?? '',
        state: row.state as HistoryEntry['state'],
        ...(row.remoteState ? { remoteState: row.remoteState } : {}),
      } as HistoryEntry;
    case 'melt':
      return {
        ...base,
        type: 'melt',
        quoteId: row.quoteId ?? '',
        state: row.state as HistoryEntry['state'],
      } as HistoryEntry;
    case 'send': {
      const token = parseToken(row.tokenJson);

      return {
        ...base,
        type: 'send',
        state: row.state as HistoryEntry['state'],
        ...(token ? { token } : {}),
      } as HistoryEntry;
    }
    case 'receive': {
      const metadata = parseReceiveSourceMetadata(row.metadata);
      return {
        ...base,
        type: 'receive',
        state: row.state as HistoryEntry['state'],
        ...(metadata ? { metadata } : {}),
        ...(row.state === 'finalized'
          ? {
              token: {
                mint: row.mintUrl,
                proofs: parseTokenProofs(row.inputProofsJson),
                unit: row.unit ?? 'sat',
              },
            }
          : {}),
      } as HistoryEntry;
    }
  }
}

function rowToLegacyInput(row: HistoryProjectionRow): LegacyHistoryRowInput {
  return {
    legacyHistoryId: row.legacyHistoryId ?? row.id.slice('legacy:'.length),
    type: row.type,
    createdAt: row.createdAt,
    mintUrl: row.mintUrl,
    unit: row.unit ?? 'sat',
    amount: deserializeAmount(row.amount),
    quoteId: row.quoteId,
    state: row.state || null,
    paymentRequest: row.paymentRequest,
    token: parseToken(row.tokenJson) as LegacyHistoryRowInput['token'],
    metadata: parseMetadata(row.metadata),
    operationId: row.operationId,
  };
}

function parseTokenProofs(
  inputProofsJson: string | null,
): NonNullable<Extract<HistoryEntry, { type: 'receive' }>['token']>['proofs'] {
  const proofs = inputProofsJson ? JSON.parse(inputProofsJson) : [];
  return proofs.map((proof: { amount: string | number }) => ({
    ...proof,
    amount: deserializeAmount(proof.amount),
  }));
}
