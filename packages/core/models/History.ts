import type { MeltQuoteState, MintQuoteState, Token } from '@cashu/cashu-ts';

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

export type ReceiveHistoryEntry = BaseHistoryEntry & {
  type: 'receive';
  amount: number;
};

export type HistoryEntry =
  | MintHistoryEntry
  | MeltHistoryEntry
  | SendHistoryEntry
  | ReceiveHistoryEntry;
