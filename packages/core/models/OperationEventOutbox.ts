import type {
  MintSwapEventType,
  MintSwapOperationState,
} from '../operations/mintSwap/MintSwapOperation';

export interface MintSwapEventPayload {
  operationId: string;
  revision: number;
  state: MintSwapOperationState;
  sourceMintUrl: string;
  destinationMintUrl: string;
  unit: 'sat';
  destinationAmount: string;
  reasonCode?: string;
}

export interface OperationEventOutboxRecord {
  id: string;
  operationId: string;
  revision: number;
  eventType: MintSwapEventType;
  payload: MintSwapEventPayload;
  createdAt: number;
  publishedAt?: number;
  publishAttempts: number;
  nextAttemptAt?: number;
  lastError?: string;
}

export function operationEventLogicalKey(
  record: Pick<OperationEventOutboxRecord, 'operationId' | 'revision' | 'eventType'>,
): string {
  return `${record.operationId}\u0000${record.revision}\u0000${record.eventType}`;
}
