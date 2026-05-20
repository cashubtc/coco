import type { Amount } from '@cashu/cashu-ts';
import type { SerializedOutputData } from '../../utils';
import type { MintMethod } from './MintMethodHandler';

export type MintBatchAttemptState = 'prepared' | 'requesting' | 'finalized' | 'recovering' | 'failed';

export interface MintBatchAttempt<M extends MintMethod = MintMethod> {
  id: string;
  mintUrl: string;
  method: M;
  unit: string;
  operationIds: string[];
  quoteIds: string[];
  quoteAmounts: Amount[];
  totalAmount: Amount;
  outputData: SerializedOutputData;
  keysetId: string;
  counterStart?: number;
  counterEnd?: number;
  state: MintBatchAttemptState;
  error?: string;
  createdAt: number;
  updatedAt: number;
  requestedAt?: number;
  finalizedAt?: number;
}
