export type OperationHookStatus = 'idle' | 'loading' | 'success' | 'error';
export type OperationBinding<TOperation extends { id: string }> = string | TOperation;

export interface OperationHookResult<TOperation extends { id: string }, TExecuteResult> {
  currentOperation: TOperation | null;
  executeResult: TExecuteResult | null;
  status: OperationHookStatus;
  error: Error | null;
  isLoading: boolean;
  isError: boolean;
  load(operationId: string): Promise<TOperation>;
  refresh(): Promise<TOperation>;
  reset(): void;
}
