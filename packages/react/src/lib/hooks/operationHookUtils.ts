import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { OperationBinding, OperationHookStatus } from './operation-types';

type ReplaceCurrentOperationOptions = {
  clearExecuteResult?: boolean;
};

type BindableOperation = {
  id: string;
  updatedAt: number;
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

export function getInitialOperationIdFromBinding<TOperation extends { id: string }>(
  binding: OperationBinding<TOperation> | null | undefined,
): string | null {
  if (typeof binding === 'string') {
    return binding;
  }

  return binding?.id ?? null;
}

export function useInitialOperationHydration<TOperation extends { id: string }>(
  binding: OperationBinding<TOperation> | null | undefined,
  hydrateOperation: (operationId: string) => Promise<void>,
): void {
  useEffect(() => {
    if (typeof binding === 'string') {
      void hydrateOperation(binding);
    }
  }, [binding, hydrateOperation]);
}

type HydrationRead = {
  operationId: string;
  source: unknown;
  epoch: number;
  promise: Promise<void>;
};

type HydrationHandlers<TResult> = {
  read: () => Promise<TResult>;
  onLoaded: (result: TResult) => void;
  onFailed: () => void;
};

export function requireCurrentOperationId<TOperation extends { id: string }>(
  currentOperation: TOperation | null,
  actionName: string,
): string {
  if (currentOperation) {
    return currentOperation.id;
  }

  throw new Error(
    `No current operation available for ${actionName}. Initialize the hook with an operation first or create one before calling ${actionName}.`,
  );
}

export function requireUnboundOperationCreation(
  boundOperationId: string | null,
  actionName: string,
): void {
  if (!boundOperationId) {
    return;
  }

  throw new Error(
    `Cannot call ${actionName} while this hook is bound to operation ${boundOperationId}. Remount the hook with a new React key or call reset() first.`,
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

export function shouldReplaceBoundOperation<TOperation extends BindableOperation>(
  currentOperation: TOperation | null,
  incomingOperation: TOperation,
): boolean {
  if (!currentOperation) {
    return true;
  }

  if (currentOperation.id !== incomingOperation.id) {
    return true;
  }

  return incomingOperation.updatedAt >= currentOperation.updatedAt;
}

/**
 * Per-hook action lock, status, error and `executeResult`, without the displayed operation.
 *
 * Hooks that observe their operation through the shared store use this directly. The legacy hooks
 * combine it with a per-hook record through {@link useOperationHookState}.
 */
export function useOperationActionState<TExecuteResult>() {
  const [executeResult, setExecuteResult] = useState<TExecuteResult | null>(null);
  const [status, setStatus] = useState<OperationHookStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  const statefulActionInProgressRef = useRef(false);
  const actionEpochRef = useRef(0);
  const actionCountRef = useRef(0);
  const hydrationReadRef = useRef<HydrationRead | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isMounted = useCallback(() => mountedRef.current, []);

  const replaceExecuteResult = useCallback((result: TExecuteResult | null) => {
    if (!mountedRef.current) {
      return;
    }

    setExecuteResult(result);
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
      actionCountRef.current += 1;
      const actionEpoch = actionEpochRef.current;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        const result = await action();
        if (onSuccess && actionEpoch === actionEpochRef.current) {
          await onSuccess(result);
        }
        if (mountedRef.current && actionEpoch === actionEpochRef.current) {
          setStatus('success');
        }
        return result;
      } catch (error) {
        const normalizedError = normalizeHookError(error);
        if (mountedRef.current && actionEpoch === actionEpochRef.current) {
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

  /**
   * Loads the operation an initial operation id names, outside the action lock.
   *
   * Hydration is not a user action, so it must not hold the lock that serializes actions: under
   * StrictMode the effect that starts it runs twice, and the replay would be rejected as an
   * overlapping action. A replay for the same id and `source` within the same epoch joins the read
   * already in flight instead of starting a second one. Pass the store or Manager a read comes from
   * as `source`, so that a read from a replaced source is not reused. The result is dropped after
   * `reset()` (which advances the epoch), once a newer hydration has started, or once any action has
   * started: an action needs a bound operation, and its own
   * result is newer than the read, so applying the read could only overwrite that action's
   * operation, `executeResult`, status or error. Unmounted hooks ignore it through `mountedRef`.
   *
   * The returned promise never rejects; failures are reported through `status` and `error`.
   */
  const runHydration = useCallback(
    <TResult>(
      operationId: string,
      { read, onLoaded, onFailed }: HydrationHandlers<TResult>,
      source?: unknown,
    ): Promise<void> => {
      const epoch = actionEpochRef.current;
      const inFlight = hydrationReadRef.current;
      if (
        inFlight &&
        inFlight.operationId === operationId &&
        inFlight.source === source &&
        inFlight.epoch === epoch
      ) {
        return inFlight.promise;
      }

      const actionCount = actionCountRef.current;
      let hydrationRead: HydrationRead | null = null;
      const isSuperseded = () =>
        epoch !== actionEpochRef.current ||
        actionCount !== actionCountRef.current ||
        hydrationReadRef.current !== hydrationRead;

      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      hydrationRead = {
        operationId,
        source,
        epoch,
        promise: Promise.resolve(),
      };
      hydrationRead.promise = (async () => {
        try {
          const result = await read();
          if (isSuperseded()) {
            return;
          }

          onLoaded(result);
          if (mountedRef.current) {
            setStatus('success');
          }
        } catch (error) {
          if (isSuperseded()) {
            return;
          }

          onFailed();
          if (mountedRef.current) {
            setError(normalizeHookError(error));
            setStatus('error');
          }
        } finally {
          if (hydrationReadRef.current === hydrationRead) {
            hydrationReadRef.current = null;
          }
        }
      })();
      hydrationReadRef.current = hydrationRead;

      return hydrationRead.promise;
    },
    [],
  );

  /** Abandons this hook's actions and reads: their late results no longer touch its state. */
  const resetActionState = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }

    actionEpochRef.current += 1;
    setExecuteResult(null);
    setStatus('idle');
    setError(null);
  }, []);

  return {
    executeResult,
    status,
    error,
    isLoading: status === 'loading',
    isError: status === 'error',
    isMounted,
    replaceExecuteResult,
    runStatefulAction,
    runHydration,
    resetActionState,
  };
}

export function useOperationHookState<TOperation extends { id: string }, TExecuteResult>(
  initialOperation: TOperation | null = null,
) {
  const actionState = useOperationActionState<TExecuteResult>();
  const { isMounted, replaceExecuteResult, resetActionState } = actionState;
  const [currentOperation, setCurrentOperation] = useState<TOperation | null>(initialOperation);
  const currentOperationRef = useRef<TOperation | null>(initialOperation);

  const replaceCurrentOperation = useCallback(
    (operation: TOperation | null, options: ReplaceCurrentOperationOptions = {}) => {
      if (!isMounted()) {
        return;
      }

      currentOperationRef.current = operation;
      setCurrentOperation(operation);
      if (options.clearExecuteResult) {
        replaceExecuteResult(null);
      }
    },
    [isMounted, replaceExecuteResult],
  );

  const getCurrentOperation = useCallback(() => {
    return currentOperationRef.current;
  }, []);

  const reset = useCallback(() => {
    if (!isMounted()) {
      return;
    }

    resetActionState();
    currentOperationRef.current = null;
    setCurrentOperation(null);
  }, [isMounted, resetActionState]);

  return {
    currentOperation,
    executeResult: actionState.executeResult,
    status: actionState.status,
    error: actionState.error,
    isLoading: actionState.isLoading,
    isError: actionState.isError,
    replaceCurrentOperation,
    replaceExecuteResult,
    getCurrentOperation,
    runStatefulAction: actionState.runStatefulAction,
    runHydration: actionState.runHydration,
    reset,
  };
}
