import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { OperationBinding, OperationHookStatus } from './operation-types';

type ReplaceCurrentOperationOptions = {
  clearExecuteResult?: boolean;
};

export function normalizeHookError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function getInitialOperationFromBinding<TOperation extends { id: string }>(
  binding: OperationBinding<TOperation> | null | undefined,
): TOperation | null {
  if (binding && typeof binding !== 'string') {
    return binding;
  }

  return null;
}

export function requireCurrentOperationId<TOperation extends { id: string }>(
  currentOperation: TOperation | null,
  actionName: string,
): string {
  if (currentOperation) {
    return currentOperation.id;
  }

  throw new Error(
    `No current operation available for ${actionName}. Call prepare(), load(operationId), or initialize the hook with an operation first.`,
  );
}

export async function requireOperation<TOperation>(
  loadOperation: (operationId: string) => Promise<TOperation | null>,
  operationId: string,
): Promise<TOperation> {
  const operation = await loadOperation(operationId);
  if (!operation) {
    throw new Error(`Operation ${operationId} not found`);
  }

  return operation;
}

export function useOperationHookState<TOperation extends { id: string }, TExecuteResult>(
  initialOperation: TOperation | null = null,
) {
  const [currentOperation, setCurrentOperation] = useState<TOperation | null>(initialOperation);
  const [executeResult, setExecuteResult] = useState<TExecuteResult | null>(null);
  const [status, setStatus] = useState<OperationHookStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  const statefulActionInProgressRef = useRef(false);
  const currentOperationRef = useRef<TOperation | null>(initialOperation);

  useLayoutEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const replaceCurrentOperation = useCallback(
    (operation: TOperation | null, options: ReplaceCurrentOperationOptions = {}) => {
      if (!mountedRef.current) {
        return;
      }

      currentOperationRef.current = operation;
      setCurrentOperation(operation);
      if (options.clearExecuteResult) {
        setExecuteResult(null);
      }
    },
    [],
  );

  const replaceExecuteResult = useCallback((result: TExecuteResult | null) => {
    if (!mountedRef.current) {
      return;
    }

    setExecuteResult(result);
  }, []);

  const getCurrentOperation = useCallback(() => {
    return currentOperationRef.current;
  }, []);

  const runStatefulAction = useCallback(
    async <T>(
      action: () => Promise<T>,
      onSuccess?: (result: T) => Promise<void> | void,
    ): Promise<T> => {
      if (statefulActionInProgressRef.current) {
        throw new Error('Operation already in progress');
      }

      statefulActionInProgressRef.current = true;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        const result = await action();
        if (onSuccess) {
          await onSuccess(result);
        }
        if (mountedRef.current) {
          setStatus('success');
        }
        return result;
      } catch (error) {
        const normalizedError = normalizeHookError(error);
        if (mountedRef.current) {
          setError(normalizedError);
          setStatus('error');
        }
        throw normalizedError;
      } finally {
        statefulActionInProgressRef.current = false;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    currentOperationRef.current = null;
    setCurrentOperation(null);
    setExecuteResult(null);
    setStatus('idle');
    setError(null);
  }, []);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading: status === 'loading',
    isError: status === 'error',
    replaceCurrentOperation,
    replaceExecuteResult,
    getCurrentOperation,
    runStatefulAction,
    reset,
  };
}
