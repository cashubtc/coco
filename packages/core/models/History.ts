import type { Amount, MeltQuoteState, Token } from '@cashu/cashu-ts';
import type { MintQuoteState } from './MintQuoteState';
import type {
  MeltOperation,
  MeltOperationState,
  PreparedOrLaterOperation as PreparedOrLaterMeltOperation,
} from '../operations/melt/MeltOperation.ts';
import type {
  MintOperation,
  MintOperationState,
  PendingOrLaterOperation as PendingOrLaterMintOperation,
} from '../operations/mint/MintOperation.ts';
import type {
  ReceiveOperation,
  ReceiveOperationState,
} from '../operations/receive/ReceiveOperation.ts';
import type {
  PreparedOrLaterOperation as PreparedOrLaterSendOperation,
  SendOperation,
  SendOperationState,
} from '../operations/send/SendOperation.ts';
import type {
  MintSwapOperation,
  MintSwapOperationState,
} from '../operations/mintSwap/MintSwapOperation.ts';

export type HistoryType = 'mint' | 'melt' | 'send' | 'receive';

type BaseHistoryEntry = {
  id: string;
  type: HistoryType;
  createdAt: number;
  updatedAt: number;
  mintUrl: string;
  unit: string;
  metadata?: Record<string, string>;
  error?: string;
};

type OperationHistoryBase = BaseHistoryEntry & {
  source: 'operation';
  operationId: string;
};

export type MintHistoryState = Exclude<MintOperationState, 'init'>;
export type MeltHistoryState = Exclude<MeltOperationState, 'init' | 'failed'>;
export type SendHistoryState = Exclude<SendOperationState, 'init'>;
export type ReceiveHistoryState = Extract<ReceiveOperationState, 'finalized' | 'rolled_back'>;

export type MintHistoryEntry = OperationHistoryBase & {
  type: 'mint';
  paymentRequest: string;
  quoteId: string;
  state: MintHistoryState;
  amount: Amount;
  remoteState?: string;
};

export type MeltHistoryEntry = OperationHistoryBase & {
  type: 'melt';
  quoteId: string;
  state: MeltHistoryState;
  amount: Amount;
};

export type SendHistoryEntry = OperationHistoryBase & {
  type: 'send';
  amount: Amount;
  state: SendHistoryState;
  /** Token is only available after execute (state >= pending) */
  token?: Token;
};

export type ReceiveHistoryEntry = OperationHistoryBase & {
  type: 'receive';
  amount: Amount;
  state: ReceiveHistoryState;
  token?: Token;
};

export type OperationHistoryEntry =
  | MintHistoryEntry
  | MeltHistoryEntry
  | SendHistoryEntry
  | ReceiveHistoryEntry;

export type LegacyMintHistoryState = MintQuoteState | string;
export type LegacyMeltHistoryState = MeltQuoteState | string;
export type LegacySendHistoryState = 'prepared' | 'pending' | 'finalized' | 'rolledBack' | string;
export type LegacyReceiveHistoryState = 'prepared' | 'finalized' | 'rolledBack' | string;

type LegacyHistoryBase = BaseHistoryEntry & {
  source: 'legacy';
  legacyHistoryId: string;
  operationId?: string;
};

export type LegacyMintHistoryEntry = LegacyHistoryBase & {
  type: 'mint';
  paymentRequest: string;
  quoteId: string;
  state: LegacyMintHistoryState;
  amount: Amount;
};

export type LegacyMeltHistoryEntry = LegacyHistoryBase & {
  type: 'melt';
  quoteId: string;
  state: LegacyMeltHistoryState;
  amount: Amount;
};

export type LegacySendHistoryEntry = LegacyHistoryBase & {
  type: 'send';
  amount: Amount;
  state: LegacySendHistoryState;
  token?: Token;
};

export type LegacyReceiveHistoryEntry = LegacyHistoryBase & {
  type: 'receive';
  amount: Amount;
  state: LegacyReceiveHistoryState;
  token?: Token;
};

export type LegacyHistoryEntry =
  | LegacyMintHistoryEntry
  | LegacyMeltHistoryEntry
  | LegacySendHistoryEntry
  | LegacyReceiveHistoryEntry;

export interface MintSwapHistoryEntry {
  id: string;
  source: 'operation';
  type: 'mint-swap';
  operationId: string;
  createdAt: number;
  updatedAt: number;
  sourceMintUrl: string;
  destinationMintUrl: string;
  /** Source mint retained for compatibility with generic history consumers. */
  mintUrl: string;
  unit: 'sat';
  amount: Amount;
  state: MintSwapOperationState;
  minimumSourceDebit?: Amount;
  maximumSourceDebit?: Amount;
  finalSourceDebit?: Amount;
  totalSourceFee?: Amount;
  reasonCode?: string;
  error?: string;
}

export type HistoryEntry = OperationHistoryEntry | LegacyHistoryEntry | MintSwapHistoryEntry;

export interface HistoryFilter {
  mintUrl?: string;
  types?: readonly (HistoryType | 'mint-swap')[];
}

export type LegacyHistoryRowInput = {
  legacyHistoryId: string | number;
  type: HistoryType;
  createdAt: number;
  mintUrl: string;
  unit: string;
  amount: Amount;
  quoteId?: string | null;
  state?: string | null;
  paymentRequest?: string | null;
  token?: Token;
  metadata?: Record<string, string>;
  operationId?: string | null;
};

export function isOperationHistoryEntry(entry: HistoryEntry): entry is OperationHistoryEntry {
  return entry.source === 'operation' && entry.type !== 'mint-swap';
}

export function isLegacyHistoryEntry(entry: HistoryEntry): entry is LegacyHistoryEntry {
  return entry.source === 'legacy';
}

export function operationHistoryId(type: HistoryType, operationId: string): string {
  return `${type}:${operationId}`;
}

export function legacyHistoryId(legacyId: string | number): string {
  return `legacy:${legacyId}`;
}

export function parseHistoryEntryId(id: string):
  | { source: 'operation'; type: HistoryType; operationId: string }
  | {
      source: 'legacy';
      legacyHistoryId: string;
    }
  | null {
  if (id.startsWith('legacy:')) {
    const legacyId = id.slice('legacy:'.length);
    return legacyId ? { source: 'legacy', legacyHistoryId: legacyId } : null;
  }

  const separator = id.indexOf(':');
  if (separator === -1) return null;
  const type = id.slice(0, separator) as HistoryType;
  const operationId = id.slice(separator + 1);
  if (!operationId || !isHistoryType(type)) return null;
  return { source: 'operation', type, operationId };
}

export function compareHistoryEntries(a: HistoryEntry, b: HistoryEntry): number {
  if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
  return b.id.localeCompare(a.id);
}

export function projectMintSwapOperation(operation: MintSwapOperation): MintSwapHistoryEntry {
  return {
    id: `mint-swap:${operation.id}`,
    source: 'operation',
    type: 'mint-swap',
    operationId: operation.id,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    sourceMintUrl: operation.sourceMintUrl,
    destinationMintUrl: operation.destinationMintUrl,
    mintUrl: operation.sourceMintUrl,
    unit: operation.unit,
    amount: operation.destinationAmount,
    state: operation.state,
    minimumSourceDebit: operation.preparedPlan?.minimumSourceDebit,
    maximumSourceDebit: operation.preparedPlan?.maximumSourceDebit,
    finalSourceDebit: operation.settlement?.finalSourceDebit,
    totalSourceFee: operation.settlement?.totalSourceFee,
    reasonCode: operation.attention?.reason ?? operation.terminalFailure?.code,
    error: operation.attention?.message ?? operation.terminalFailure?.reason,
  };
}

export function projectSendOperation(operation: SendOperation): SendHistoryEntry | null {
  if (operation.state === 'init') return null;

  const prepared = operation as PreparedOrLaterSendOperation;
  const token = 'token' in prepared ? prepared.token : undefined;

  return {
    id: operationHistoryId('send', prepared.id),
    source: 'operation',
    type: 'send',
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
    mintUrl: prepared.mintUrl,
    unit: prepared.unit,
    operationId: prepared.id,
    amount: prepared.amount,
    state: prepared.state,
    ...(prepared.error ? { error: prepared.error } : {}),
    ...(token ? { token } : {}),
  };
}

export function projectMeltOperation(operation: MeltOperation): MeltHistoryEntry | null {
  if (operation.state === 'init' || operation.state === 'failed') return null;

  const prepared = operation as PreparedOrLaterMeltOperation;
  return {
    id: operationHistoryId('melt', prepared.id),
    source: 'operation',
    type: 'melt',
    createdAt: prepared.createdAt,
    updatedAt: prepared.updatedAt,
    mintUrl: prepared.mintUrl,
    unit: prepared.unit || 'sat',
    operationId: prepared.id,
    quoteId: prepared.quoteId,
    amount: prepared.amount,
    state: prepared.state as MeltHistoryState,
    ...(prepared.error ? { error: prepared.error } : {}),
  };
}

export function projectMintOperation(operation: MintOperation): MintHistoryEntry | null {
  if (operation.state === 'init') return null;

  const pending = operation as PendingOrLaterMintOperation;
  return {
    id: operationHistoryId('mint', pending.id),
    source: 'operation',
    type: 'mint',
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
    mintUrl: pending.mintUrl,
    unit: pending.unit,
    operationId: pending.id,
    quoteId: pending.quoteId,
    paymentRequest: pending.request,
    amount: pending.amount,
    state: pending.state,
    ...(pending.error ? { error: pending.error } : {}),
  };
}

export function projectReceiveOperation(operation: ReceiveOperation): ReceiveHistoryEntry | null {
  if (operation.state !== 'finalized' && operation.state !== 'rolled_back') return null;

  const metadata = getReceiveOperationMetadata(operation);
  const token =
    operation.state === 'finalized'
      ? {
          mint: operation.mintUrl,
          proofs: operation.inputProofs,
          unit: operation.unit || 'sat',
        }
      : undefined;

  return {
    id: operationHistoryId('receive', operation.id),
    source: 'operation',
    type: 'receive',
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    mintUrl: operation.mintUrl,
    unit: operation.unit || 'sat',
    operationId: operation.id,
    amount: operation.amount,
    state: operation.state,
    ...(metadata ? { metadata } : {}),
    ...(operation.error ? { error: operation.error } : {}),
    ...(token ? { token } : {}),
  };
}

function getReceiveOperationMetadata(
  operation: ReceiveOperation,
): Record<string, string> | undefined {
  if (operation.source?.type !== 'payment-request') {
    return undefined;
  }

  return {
    source: 'payment-request',
    requestOperationId: operation.source.requestOperationId,
    attemptId: operation.source.attemptId,
    ...(operation.source.requestId ? { requestId: operation.source.requestId } : {}),
    transport: operation.source.transport,
    ...(operation.source.transportMessageId
      ? { transportMessageId: operation.source.transportMessageId }
      : {}),
    ...(operation.source.senderPubkey ? { senderPubkey: operation.source.senderPubkey } : {}),
    ...(operation.source.memo ? { memo: operation.source.memo } : {}),
  };
}

export function projectOperationToHistoryEntry(
  type: HistoryType,
  operation: SendOperation | MeltOperation | MintOperation | ReceiveOperation,
): OperationHistoryEntry | null {
  switch (type) {
    case 'send':
      return projectSendOperation(operation as SendOperation);
    case 'melt':
      return projectMeltOperation(operation as MeltOperation);
    case 'mint':
      return projectMintOperation(operation as MintOperation);
    case 'receive':
      return projectReceiveOperation(operation as ReceiveOperation);
  }
}

export function projectLegacyHistoryRow(row: LegacyHistoryRowInput): LegacyHistoryEntry {
  const base = {
    id: legacyHistoryId(row.legacyHistoryId),
    source: 'legacy' as const,
    legacyHistoryId: String(row.legacyHistoryId),
    type: row.type,
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    mintUrl: row.mintUrl,
    unit: row.unit,
    amount: row.amount,
    ...(row.metadata ? { metadata: row.metadata } : {}),
    ...(row.operationId ? { operationId: row.operationId } : {}),
  };

  switch (row.type) {
    case 'mint':
      return {
        ...base,
        type: 'mint',
        quoteId: row.quoteId ?? '',
        paymentRequest: row.paymentRequest ?? '',
        state: row.state ?? 'UNPAID',
      };
    case 'melt':
      return {
        ...base,
        type: 'melt',
        quoteId: row.quoteId ?? '',
        state: row.state ?? 'UNPAID',
      };
    case 'send':
      return {
        ...base,
        type: 'send',
        state: row.state ?? 'pending',
        ...(row.token ? { token: row.token } : {}),
      };
    case 'receive':
      return {
        ...base,
        type: 'receive',
        state: row.state ?? 'finalized',
        ...(row.token ? { token: row.token } : {}),
      };
  }
}

function isHistoryType(value: string): value is HistoryType {
  return value === 'mint' || value === 'melt' || value === 'send' || value === 'receive';
}
