import type { Manager } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';

import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  getInitialOperationIdFromBinding,
  requireCurrentOperationId,
  requireOperation,
  requireUnboundOperationCreation,
  useInitialOperationHydration,
  useOperationHookState,
} from './operationHookUtils';

type MintSwapOps = Manager['ops']['mintSwap'];
type MintSwapOperation = NonNullable<Awaited<ReturnType<MintSwapOps['get']>>>;

export type MintSwapPrepareInput = Parameters<MintSwapOps['prepare']>[0];
export type MintSwapListInput = Parameters<MintSwapOps['list']>[0];

export interface UseMintSwapOperationResult extends OperationHookResult<
  MintSwapOperation,
  MintSwapOperation
> {
  prepare(input: MintSwapPrepareInput): Promise<MintSwapOperation>;
  execute(): Promise<MintSwapOperation>;
  retry(): Promise<MintSwapOperation>;
  cancel(reason?: string): Promise<MintSwapOperation>;
  list(input?: MintSwapListInput): ReturnType<MintSwapOps['list']>;
  listActive(): ReturnType<MintSwapOps['listActive']>;
}

export function useMintSwapOperation(
  initialBinding?: OperationBinding<MintSwapOperation> | null,
): UseMintSwapOperationResult {
  const manager = useManager();
  const initialBindingRef = useRef(initialBinding);
  const boundIdRef = useRef(getInitialOperationIdFromBinding(initialBindingRef.current));
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
    runStatefulAction,
    reset: resetState,
  } = useOperationHookState<MintSwapOperation, MintSwapOperation>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const bind = useCallback(
    (operation: MintSwapOperation | null, clearExecuteResult = false) => {
      if (!operation) {
        boundIdRef.current = null;
        replaceCurrentOperation(null, { clearExecuteResult });
        return;
      }
      if (boundIdRef.current && boundIdRef.current !== operation.id) return;
      const current = getCurrentOperation();
      if (current?.id === operation.id && current.revision > operation.revision) return;
      boundIdRef.current = operation.id;
      replaceCurrentOperation(operation, { clearExecuteResult });
    },
    [getCurrentOperation, replaceCurrentOperation],
  );

  const hydrate = useCallback(
    async (operationId: string) => {
      const operation = await requireOperation((id) => manager.ops.mintSwap.get(id), operationId);
      if (boundIdRef.current === operationId) bind(operation, true);
    },
    [bind, manager],
  );
  useInitialOperationHydration(initialBindingRef.current, hydrate);

  useEffect(() => {
    let active = true;
    const observe = async (payload: { operationId: string; revision: number }) => {
      if (!active || payload.operationId !== boundIdRef.current) return;
      const current = getCurrentOperation();
      if (current && payload.revision <= current.revision) return;
      const operation = await manager.ops.mintSwap.get(payload.operationId);
      if (active && operation) bind(operation);
    };
    const events = [
      'mint-swap-op:prepared',
      'mint-swap-op:source-inflight',
      'mint-swap-op:destination-funded',
      'mint-swap-op:issuing',
      'mint-swap-op:completed',
      'mint-swap-op:cancelled',
      'mint-swap-op:failed',
      'mint-swap-op:needs-attention',
      'mint-swap-op:delayed',
    ] as const;
    const offs = events.map((event) => manager.on(event, observe));
    return () => {
      active = false;
      for (const off of offs) off();
    };
  }, [bind, getCurrentOperation, manager]);

  const prepare = useCallback(
    (input: MintSwapPrepareInput) => {
      requireUnboundOperationCreation(boundIdRef.current, 'prepare');
      return runStatefulAction(
        () => manager.ops.mintSwap.prepare(input),
        (operation) => bind(operation, true),
      );
    },
    [bind, manager, runStatefulAction],
  );
  const runBound = useCallback(
    (action: (operationId: string) => Promise<MintSwapOperation>) => {
      const id = requireCurrentOperationId(getCurrentOperation(), 'mint swap action');
      return runStatefulAction(
        () => action(id),
        (operation) => bind(operation),
      );
    },
    [bind, getCurrentOperation, runStatefulAction],
  );
  const execute = useCallback(async () => {
    const operation = await runBound((id) => manager.ops.mintSwap.execute(id));
    replaceExecuteResult(operation);
    return operation;
  }, [manager, replaceExecuteResult, runBound]);
  const refresh = useCallback(
    () => runBound((id) => manager.ops.mintSwap.refresh(id)),
    [manager, runBound],
  );
  const retry = useCallback(
    () => runBound((id) => manager.ops.mintSwap.retry(id)),
    [manager, runBound],
  );
  const cancel = useCallback(
    (reason?: string) => runBound((id) => manager.ops.mintSwap.cancel(id, reason)),
    [manager, runBound],
  );
  const reset = useCallback(() => {
    boundIdRef.current = null;
    resetState();
  }, [resetState]);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading,
    isError,
    prepare,
    execute,
    refresh,
    retry,
    cancel,
    list: (input) => manager.ops.mintSwap.list(input),
    listActive: () => manager.ops.mintSwap.listActive(),
    reset,
  };
}
