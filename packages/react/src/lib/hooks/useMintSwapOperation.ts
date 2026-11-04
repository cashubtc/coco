import type { Manager, MintSwapOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult, OperationHookStatus } from './operation-types';
import {
  getInitialOperationFromBinding,
  getInitialOperationIdFromBinding,
  normalizeHookError,
  requireCurrentOperationId,
  requireUnboundOperationCreation,
} from './operationHookUtils';

type MintSwapOps = Manager['ops']['mintSwap'];

export type MintSwapOperationPrepareInput = Parameters<MintSwapOps['prepare']>[0];
export type MintSwapOperationPrepareResult = Awaited<ReturnType<MintSwapOps['prepare']>>;
export type MintSwapOperationExecuteResult = Awaited<ReturnType<MintSwapOps['execute']>>;
export type MintSwapOperationCancelResult = Awaited<ReturnType<MintSwapOps['cancel']>>;
export type MintSwapOperationWaitOptions = NonNullable<
  Parameters<MintSwapOps['waitForOutcome']>[1]
>;
export type MintSwapOperationWaitResult = Awaited<ReturnType<MintSwapOps['waitForOutcome']>>;
export type MintSwapOperationActiveList = Awaited<ReturnType<MintSwapOps['listActive']>>;

export interface UseMintSwapOperationResult extends OperationHookResult<
  MintSwapOperation,
  MintSwapOperationExecuteResult
> {
  prepare(input: MintSwapOperationPrepareInput): Promise<MintSwapOperationPrepareResult>;
  execute(): Promise<MintSwapOperationExecuteResult>;
  cancel(): Promise<MintSwapOperationCancelResult>;
  waitForOutcome(options?: MintSwapOperationWaitOptions): Promise<MintSwapOperationWaitResult>;
  listActive(): Promise<MintSwapOperationActiveList>;
}

type ReadState = { epoch: number; reading: boolean; requested: boolean };

function isQuiescent(operation: MintSwapOperation): boolean {
  return (
    operation.state === 'completed' ||
    operation.state === 'cancelled' ||
    operation.state === 'failed' ||
    operation.state === 'needs_attention'
  );
}

export function useMintSwapOperation(
  initialBinding?: OperationBinding<MintSwapOperation> | null,
): UseMintSwapOperationResult {
  const manager = useManager();
  const initialBindingRef = useRef(initialBinding);
  const initialOperation = getInitialOperationFromBinding(initialBindingRef.current);
  const boundOperationIdRef = useRef(getInitialOperationIdFromBinding(initialBindingRef.current));
  const currentOperationRef = useRef<MintSwapOperation | null>(initialOperation);
  const managerRef = useRef(manager);
  const previousManagerRef = useRef(manager);
  const mountedRef = useRef(true);
  const epochRef = useRef(0);
  const readStateRef = useRef<ReadState>({ epoch: 0, reading: false, requested: false });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Epochs fence stale state updates, but a submitted effect keeps this lock until it settles.
  const commandRef = useRef<symbol | null>(null);
  const hydrationErrorRef = useRef<Error | null>(null);
  const waitAbortRef = useRef(new AbortController());

  const [currentOperation, setCurrentOperation] = useState<MintSwapOperation | null>(
    initialOperation,
  );
  const [executeResult, setExecuteResult] = useState<MintSwapOperationExecuteResult | null>(null);
  const [status, setStatus] = useState<OperationHookStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const bindOperation = useCallback(
    (operation: MintSwapOperation, options?: { clearExecuteResult?: boolean }) => {
      if (!mountedRef.current || operation.id !== boundOperationIdRef.current) return;
      const current = currentOperationRef.current;
      if (current?.id === operation.id && operation.revision < current.revision) return;
      currentOperationRef.current = operation;
      setCurrentOperation(operation);
      if (options?.clearExecuteResult) setExecuteResult(null);
      if (isQuiescent(operation)) stopPolling();
    },
    [stopPolling],
  );

  const queueRead = useCallback(() => {
    const operationId = boundOperationIdRef.current;
    if (!operationId) return;
    const epoch = epochRef.current;
    let state = readStateRef.current;
    if (state.epoch !== epoch) {
      state = { epoch, reading: false, requested: false };
      readStateRef.current = state;
    }
    state.requested = true;
    if (state.reading) return;
    state.reading = true;
    const selectedManager = managerRef.current;

    void (async () => {
      try {
        while (state.requested && epoch === epochRef.current) {
          state.requested = false;
          const operation = await selectedManager.ops.mintSwap.get(operationId);
          if (
            epoch !== epochRef.current ||
            selectedManager !== managerRef.current ||
            operationId !== boundOperationIdRef.current
          ) {
            return;
          }
          if (!operation) throw new Error(`Operation ${operationId} not found`);
          bindOperation(operation);
          if (hydrationErrorRef.current && mountedRef.current) {
            hydrationErrorRef.current = null;
            setError(null);
            setStatus('success');
          }
        }
      } catch (readError) {
        if (epoch === epochRef.current && selectedManager === managerRef.current) {
          console.error(readError);
          if (!currentOperationRef.current && mountedRef.current) {
            const normalized = normalizeHookError(readError);
            hydrationErrorRef.current = normalized;
            setError(normalized);
            setStatus('error');
          }
        }
      } finally {
        state.reading = false;
        if (state.requested && epoch === epochRef.current) queueRead();
      }
    })();
  }, [bindOperation]);

  const ensurePolling = useCallback(() => {
    const operation = currentOperationRef.current;
    if (!boundOperationIdRef.current || (operation && isQuiescent(operation))) {
      stopPolling();
      return;
    }
    if (!pollRef.current) pollRef.current = setInterval(queueRead, 1_000);
  }, [queueRead, stopPolling]);

  useEffect(() => {
    const replacingManager = previousManagerRef.current !== manager;
    previousManagerRef.current = manager;
    managerRef.current = manager;
    epochRef.current += 1;
    readStateRef.current = { epoch: epochRef.current, reading: false, requested: false };
    stopPolling();
    waitAbortRef.current.abort(new Error('Mint Swap observer changed'));
    waitAbortRef.current = new AbortController();

    if (replacingManager) {
      hydrationErrorRef.current = null;
      currentOperationRef.current = null;
      setCurrentOperation(null);
      setExecuteResult(null);
      setStatus('idle');
      setError(null);
    }

    const unsubscribe = manager.on('mint-swap:updated', ({ operationId }) => {
      if (operationId === boundOperationIdRef.current) queueRead();
    });
    if (boundOperationIdRef.current) {
      queueRead();
      ensurePolling();
    }

    return () => {
      unsubscribe();
      epochRef.current += 1;
      readStateRef.current = { epoch: epochRef.current, reading: false, requested: false };
      stopPolling();
      waitAbortRef.current.abort(new Error('Mint Swap observer disposed'));
    };
  }, [ensurePolling, manager, queueRead, stopPolling]);

  const runCommand = useCallback(
    async <T>(
      action: (selectedManager: Manager) => Promise<T>,
      onSuccess: (result: T) => void,
    ): Promise<T> => {
      if (commandRef.current) throw new Error('Operation already in progress');
      const token = Symbol('mint-swap-command');
      commandRef.current = token;
      hydrationErrorRef.current = null;
      const selectedManager = managerRef.current;
      const epoch = epochRef.current;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }
      try {
        const result = await action(selectedManager);
        if (epoch === epochRef.current && selectedManager === managerRef.current) {
          onSuccess(result);
          if (mountedRef.current) setStatus('success');
        }
        return result;
      } catch (commandError) {
        const normalized = normalizeHookError(commandError);
        if (
          epoch === epochRef.current &&
          selectedManager === managerRef.current &&
          mountedRef.current
        ) {
          setError(normalized);
          setStatus('error');
        }
        throw normalized;
      } finally {
        if (commandRef.current === token) commandRef.current = null;
      }
    },
    [],
  );

  const prepare = useCallback(
    async (input: MintSwapOperationPrepareInput) => {
      requireUnboundOperationCreation(boundOperationIdRef.current, 'prepare');
      return runCommand(
        (selectedManager) => selectedManager.ops.mintSwap.prepare(input),
        (operation) => {
          boundOperationIdRef.current = operation.id;
          bindOperation(operation, { clearExecuteResult: true });
          ensurePolling();
        },
      );
    },
    [bindOperation, ensurePolling, runCommand],
  );

  const refresh = useCallback(async () => {
    const id = requireCurrentOperationId(currentOperationRef.current, 'refresh');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.refresh(id),
      (operation) => {
        bindOperation(operation);
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, runCommand]);

  const execute = useCallback(async () => {
    const id = requireCurrentOperationId(currentOperationRef.current, 'execute');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.execute(id),
      (operation) => {
        bindOperation(operation);
        setExecuteResult(operation);
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, runCommand]);

  const cancel = useCallback(async () => {
    const id = requireCurrentOperationId(currentOperationRef.current, 'cancel');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.cancel(id),
      (operation) => {
        bindOperation(operation, { clearExecuteResult: true });
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, runCommand]);

  const waitForOutcome = useCallback(
    async (options: MintSwapOperationWaitOptions = {}) => {
      const id = requireCurrentOperationId(currentOperationRef.current, 'waitForOutcome');
      const selectedManager = managerRef.current;
      const epoch = epochRef.current;
      const internalSignal = waitAbortRef.current.signal;
      const signal = options.signal
        ? AbortSignal.any([options.signal, internalSignal])
        : internalSignal;
      try {
        const outcome = await selectedManager.ops.mintSwap.waitForOutcome(id, {
          ...options,
          signal,
        });
        if (epoch === epochRef.current && selectedManager === managerRef.current) {
          bindOperation(outcome.operation);
        }
        return outcome;
      } catch (waitError) {
        throw normalizeHookError(waitError);
      }
    },
    [bindOperation],
  );

  const listActive = useCallback(() => managerRef.current.ops.mintSwap.listActive(), []);

  const reset = useCallback(() => {
    epochRef.current += 1;
    readStateRef.current = { epoch: epochRef.current, reading: false, requested: false };
    stopPolling();
    waitAbortRef.current.abort(new Error('Mint Swap hook reset'));
    waitAbortRef.current = new AbortController();
    hydrationErrorRef.current = null;
    boundOperationIdRef.current = null;
    currentOperationRef.current = null;
    if (mountedRef.current) {
      setCurrentOperation(null);
      setExecuteResult(null);
      setStatus('idle');
      setError(null);
    }
  }, [stopPolling]);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading: status === 'loading',
    isError: status === 'error',
    prepare,
    refresh,
    execute,
    cancel,
    waitForOutcome,
    listActive,
    reset,
  };
}
