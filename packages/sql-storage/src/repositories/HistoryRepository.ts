import type {
  HistoryEntry,
  HistoryRepository,
  HistoryType,
  LegacyHistoryRowInput,
  MeltOperation,
  MintOperation,
} from '@cashu/coco-core/adapter';
import type { Token } from '@cashu/cashu-ts';
import {
  deserializeAmount,
  deserializeMintSwapOperation,
  deserializeToken,
  operationHistoryId,
  parseHistoryEntryId,
  projectLegacyHistoryRow,
  projectMintSwapHistoryEntry,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase } from '../index.ts';

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
  batchMintOperationId: string | null;
  mintSwapRecordJson: string | null;
  sourceChildId: string | null;
  sourceChildState: string | null;
  sourceChildUpdatedAt: number | null;
  destinationChildId: string | null;
  destinationChildState: string | null;
  destinationChildUpdatedAt: number | null;
};

function projectionSelect(suppressOwnedChildren: boolean): string {
  const sourceVisibility = suppressOwnedChildren
    ? `AND NOT EXISTS (
         SELECT 1 FROM coco_cashu_mint_swap_operations swap
         WHERE swap.sourceOperationId = melt.id
       )`
    : '';
  const destinationVisibility = suppressOwnedChildren
    ? `AND NOT EXISTS (
         SELECT 1 FROM coco_cashu_mint_swap_operations swap
         WHERE swap.destinationOperationId = op.id
       )`
    : '';
  return `
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
      error,
      NULL AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
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
      error,
      NULL AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
    FROM coco_cashu_melt_operations melt
    WHERE state IN ('prepared', 'executing', 'pending', 'finalized', 'rolling_back', 'rolled_back')
    ${sourceVisibility}

    UNION ALL

    SELECT
      'operation' AS source,
      'mint:' || op.id AS id,
      NULL AS legacyHistoryId,
      'mint' AS type,
      op.mintUrl,
      op.unit,
      op.amount,
      op.createdAt * 1000 AS createdAt,
      op.updatedAt * 1000 AS updatedAt,
      op.state,
      op.quoteId,
      op.request AS paymentRequest,
      NULL AS tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      op.id AS operationId,
      q.state AS remoteState,
      op.error,
      NULL AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
    FROM coco_cashu_mint_operations op
    LEFT JOIN coco_cashu_canonical_mint_quotes q
      ON q.mintUrl = op.mintUrl
     AND q.method = op.method
     AND q.quoteId = op.quoteId
    WHERE op.state != 'init'
    ${destinationVisibility}

    UNION ALL

    SELECT
      'operation' AS source,
      'batch-mint:' || op.id || ':' || m.ordinal AS id,
      NULL AS legacyHistoryId,
      'mint' AS type,
      op.mintUrl,
      op.unit,
      m.amount,
      op.createdAt AS createdAt,
      op.updatedAt AS updatedAt,
      op.state,
      m.quoteId,
      m.request AS paymentRequest,
      NULL AS tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      op.id AS operationId,
      q.state AS remoteState,
      op.error,
      op.id AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
    FROM coco_cashu_batch_mint_members m
    JOIN coco_cashu_batch_mint_operations op ON op.id = m.operationId
    LEFT JOIN coco_cashu_canonical_mint_quotes q
      ON q.mintUrl = op.mintUrl
     AND q.method = op.method
     AND q.quoteId = m.quoteId

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
      error,
      NULL AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
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
      NULL AS error,
      NULL AS batchMintOperationId,
      NULL AS mintSwapRecordJson,
      NULL AS sourceChildId,
      NULL AS sourceChildState,
      NULL AS sourceChildUpdatedAt,
      NULL AS destinationChildId,
      NULL AS destinationChildState,
      NULL AS destinationChildUpdatedAt
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
          SELECT 'mint' AS type, mintUrl, quoteId
          FROM coco_cashu_batch_mint_members
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

    UNION ALL

    SELECT
      'operation' AS source,
      'mint-swap:' || swap.id AS id,
      NULL AS legacyHistoryId,
      'mint-swap' AS type,
      '' AS mintUrl,
      'sat' AS unit,
      0 AS amount,
      swap.createdAt AS createdAt,
      swap.updatedAt AS updatedAt,
      swap.state,
      NULL AS quoteId,
      NULL AS paymentRequest,
      NULL AS tokenJson,
      NULL AS inputProofsJson,
      NULL AS metadata,
      swap.id AS operationId,
      NULL AS remoteState,
      NULL AS error,
      NULL AS batchMintOperationId,
      swap.recordJson AS mintSwapRecordJson,
      source.id AS sourceChildId,
      source.state AS sourceChildState,
      source.updatedAt * 1000 AS sourceChildUpdatedAt,
      destination.id AS destinationChildId,
      destination.state AS destinationChildState,
      destination.updatedAt * 1000 AS destinationChildUpdatedAt
    FROM coco_cashu_mint_swap_operations swap
    LEFT JOIN coco_cashu_melt_operations source ON source.id = swap.sourceOperationId
    LEFT JOIN coco_cashu_mint_operations destination
      ON destination.id = swap.destinationOperationId
  )
`;
}

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
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const rows = await this.db.all<HistoryProjectionRow>(
      `${projectionSelect(true)}
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
        `${projectionSelect(true)}
         WHERE source = 'legacy' AND legacyHistoryId = ?
         LIMIT 1`,
        [parsed.legacyHistoryId],
      );
      return row ? rowToEntry(row) : null;
    }

    if (parsed.source === 'batch-mint') {
      const row = await this.db.get<HistoryProjectionRow>(
        `${projectionSelect(true)}
         WHERE source = 'operation' AND batchMintOperationId = ? AND id = ?
         LIMIT 1`,
        [parsed.operationId, id],
      );
      return row ? rowToEntry(row) : null;
    }

    const row = await this.db.get<HistoryProjectionRow>(
      `${projectionSelect(parsed.type === 'mint-swap')}
       WHERE source = 'operation' AND type = ? AND operationId = ? AND batchMintOperationId IS NULL
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

  if (row.type === 'mint-swap') {
    if (!row.mintSwapRecordJson) throw new TypeError('Mint Swap history row is missing its record');
    const parent = deserializeMintSwapOperation(row.mintSwapRecordJson);
    const sourceChild = row.sourceChildId
      ? ({
          id: row.sourceChildId,
          state: row.sourceChildState,
          updatedAt: row.sourceChildUpdatedAt,
        } as MeltOperation)
      : null;
    const destinationChild = row.destinationChildId
      ? ({
          id: row.destinationChildId,
          state: row.destinationChildState,
          updatedAt: row.destinationChildUpdatedAt,
        } as MintOperation)
      : null;
    return projectMintSwapHistoryEntry(parent, sourceChild, destinationChild);
  }

  const base = {
    id: row.batchMintOperationId ? row.id : operationHistoryId(row.type, row.operationId ?? ''),
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
        ...(row.batchMintOperationId ? { batchMintOperationId: row.batchMintOperationId } : {}),
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
  if (row.type === 'mint-swap') throw new TypeError('Legacy Mint Swap history is unsupported');
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
