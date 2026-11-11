import type { ReceiveOperation, ReceiveOperationState } from './ReceiveOperation.ts';

/** Informational reads only; commands reload state inside their transaction. */
export interface ReceiveOperationQueries {
  getById(id: string): Promise<ReceiveOperation | null>;
  getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]>;
  getPending(): Promise<ReceiveOperation[]>;
}
