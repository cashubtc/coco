import type { MeltQuoteState, Token } from '@cashu/cashu-ts';
import type { MintQuoteState } from './MintQuoteState';

type BaseHistoryEntry = {
  id: string;
  createdAt: number;
  mintUrl: string;
  unit: string;
  metadata?: Record<string, string>;
  operationId?: string;
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

/**
 * Simplified state for send history entries.
 * Maps from SendOperationState to a user-facing state.
 */
export type SendHistoryState = 'prepared' | 'pending' | 'finalized' | 'rolledBack';

export type SendHistoryEntry = BaseHistoryEntry & {
  type: 'send';
  amount: number;
  operationId: string;
  state: SendHistoryState;
  /** Token is only available after execute (state >= pending) */
  token?: Token;
};

export type ReceiveHistoryState = 'prepared' | 'finalized' | 'rolledBack';

export type ReceiveHistoryEntry = BaseHistoryEntry & {
  type: 'receive';
  amount: number;
  state: ReceiveHistoryState;
  token?: Token;
};

export type HistoryEntry =
  | MintHistoryEntry
  | MeltHistoryEntry
  | SendHistoryEntry
  | ReceiveHistoryEntry;
