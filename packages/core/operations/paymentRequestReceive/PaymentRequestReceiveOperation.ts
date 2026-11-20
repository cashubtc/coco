import type { Amount, PaymentRequestPayload, Proof } from '@cashu/cashu-ts';

export type PaymentRequestReceiveState = 'active' | 'completed' | 'cancelled';

export type PaymentRequestReceiveAttemptState =
  | 'received'
  | 'validating'
  | 'receiving'
  | 'finalized'
  | 'rejected';

export type PaymentRequestReceiveTransport = 'inband' | 'nostr' | 'post';

export type PaymentRequestReceiveSource = {
  transport: PaymentRequestReceiveTransport;
  transportMessageId?: string;
  senderPubkey?: string;
};

export interface PaymentRequestReceiveOperation {
  id: string;
  requestId?: string;
  encodedRequest: string;
  state: PaymentRequestReceiveState;
  transport: PaymentRequestReceiveTransport;
  amount: Amount;
  unit: string;
  mints: string[];
  singleUse: boolean;
  description?: string;
  /** Local lifecycle creation time as Unix milliseconds. */
  createdAt: number;
  /** Local lifecycle update time as Unix milliseconds. */
  updatedAt: number;
  error?: string;
  /** Local completion time as Unix milliseconds, absent until completed. */
  completedAt?: number;
}

export interface PaymentRequestReceiveAttempt {
  id: string;
  requestOperationId: string;
  requestId?: string;
  transport: PaymentRequestReceiveTransport;
  transportMessageId?: string;
  payloadHash: string;
  senderPubkey?: string;
  memo?: string;
  mintUrl: string;
  unit: string;
  grossAmount: Amount;
  fee?: Amount;
  netAmount?: Amount;
  receiveOperationId?: string;
  state: PaymentRequestReceiveAttemptState;
  error?: string;
  payload?: PaymentRequestPayload;
  /** Local lifecycle creation time as Unix milliseconds. */
  createdAt: number;
  /** Local lifecycle update time as Unix milliseconds. */
  updatedAt: number;
}

export type ParsedPaymentRequestPayload = {
  id?: string;
  memo?: string;
  mint: string;
  unit: string;
  proofs: Proof[];
};
