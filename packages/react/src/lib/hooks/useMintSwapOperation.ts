import type { Manager, MintSwapOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  getInitialOperationIdFromBinding,
  normalizeHookError,
  requireCurrentOperationId,
  requireUnboundOperationCreation,
  useOperationHookState,
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
  const managerRef = useRef(manager);
  const previousManagerRef = useRef(manager);
  const epochRef = useRef(0);
  const readStateRef = useRef<ReadState>({ epoch: 0, reading: false, requested: false });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hydrationErrorRef = useRef<Error | null>(null);
  const waitAbortRef = useRef(new AbortController());

  const {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading,
    isError,
    replaceCurrentOperation,
    replaceExecuteResult,
    getCurrentOperation,
    replaceStatus,
    runStatefulAction,
    reset: resetState,
  } = useOperationHookState<MintSwapOperation, MintSwapOperationExecuteResult>(initialOperation);

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  const bindOperation = useCallback(
    (operation: MintSwapOperation, options?: { clearExecuteResult?: boolean }) => {
      if (operation.id !== boundOperationIdRef.current) return;
      const current = getCurrentOperation();
      if (current?.id === operation.id && operation.revision < current.revision) return;
      replaceCurrentOperation(operation, options);
      if (isQuiescent(operation)) stopPolling();
    },
    [getCurrentOperation, replaceCurrentOperation, stopPolling],
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
    const hydrating = !getCurrentOperation();
    if (hydrating) replaceStatus('loading');

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
          if (!operation) {
            stopPolling();
            if (!getCurrentOperation()) {
              const notFoundError = new Error(`Operation ${operationId} not found`);
              boundOperationIdRef.current = null;
              hydrationErrorRef.current = notFoundError;
              replaceCurrentOperation(null, { clearExecuteResult: true });
              replaceStatus('error', notFoundError);
            }
            return;
          }
          bindOperation(operation);
          if (hydrating || hydrationErrorRef.current) {
            hydrationErrorRef.current = null;
            replaceStatus('success');
          }
        }
      } catch (readError) {
        if (epoch === epochRef.current && selectedManager === managerRef.current) {
          const normalized = normalizeHookError(readError);
          console.error(readError);
          if (!getCurrentOperation()) {
            hydrationErrorRef.current = normalized;
            replaceStatus('error', normalized);
          }
        }
      } finally {
        state.reading = false;
        if (state.requested && epoch === epochRef.current) queueRead();
      }
    })();
  }, [bindOperation, getCurrentOperation, replaceCurrentOperation, replaceStatus, stopPolling]);

  const ensurePolling = useCallback(() => {
    const operation = getCurrentOperation();
    if (!boundOperationIdRef.current || (operation && isQuiescent(operation))) {
      stopPolling();
      return;
    }
    if (!pollRef.current) pollRef.current = setInterval(queueRead, 1_000);
  }, [getCurrentOperation, queueRead, stopPolling]);

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
      resetState();
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
  }, [ensurePolling, manager, queueRead, resetState, stopPolling]);

  const runCommand = useCallback(
    async <T>(
      action: (selectedManager: Manager) => Promise<T>,
      onSuccess: (result: T) => void,
    ): Promise<T> => {
      hydrationErrorRef.current = null;
      const selectedManager = managerRef.current;
      const epoch = epochRef.current;
      return runStatefulAction(
        () => action(selectedManager),
        (result) => {
          if (epoch === epochRef.current && selectedManager === managerRef.current) {
            onSuccess(result);
          }
        },
      );
    },
    [runStatefulAction],
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
    const id = requireCurrentOperationId(getCurrentOperation(), 'refresh');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.refresh(id),
      (operation) => {
        bindOperation(operation);
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, getCurrentOperation, runCommand]);

  const execute = useCallback(async () => {
    const id = requireCurrentOperationId(getCurrentOperation(), 'execute');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.execute(id),
      (operation) => {
        bindOperation(operation);
        replaceExecuteResult(operation);
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, getCurrentOperation, replaceExecuteResult, runCommand]);

  const cancel = useCallback(async () => {
    const id = requireCurrentOperationId(getCurrentOperation(), 'cancel');
    return runCommand(
      (selectedManager) => selectedManager.ops.mintSwap.cancel(id),
      (operation) => {
        bindOperation(operation, { clearExecuteResult: true });
        ensurePolling();
      },
    );
  }, [bindOperation, ensurePolling, getCurrentOperation, runCommand]);

  const waitForOutcome = useCallback(
    async (options: MintSwapOperationWaitOptions = {}) => {
      const id = requireCurrentOperationId(getCurrentOperation(), 'waitForOutcome');
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
    [bindOperation, getCurrentOperation],
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
    resetState();
  }, [resetState, stopPolling]);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading,
    isError,
    prepare,
    refresh,
    execute,
    cancel,
    waitForOutcome,
    listActive,
    reset,
  };
}
