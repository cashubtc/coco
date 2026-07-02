import type { Manager, ReceiveOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationIdFromBinding,
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
  requireUnboundOperationCreation,
  shouldReplaceBoundOperation,
  useInitialOperationHydration,
  useOperationHookState,
} from './operationHookUtils';

type ReceiveOps = Manager['ops']['receive'];

export type ReceiveOperationPrepareInput = Parameters<ReceiveOps['prepare']>[0];
export type ReceiveOperationPrepareResult = Awaited<ReturnType<ReceiveOps['prepare']>>;
export type ReceiveOperationExecuteResult = Awaited<ReturnType<ReceiveOps['execute']>>;
export type ReceiveOperationListPreparedResult = Awaited<ReturnType<ReceiveOps['listPrepared']>>;
export type ReceiveOperationListDeferredResult = Awaited<ReturnType<ReceiveOps['listDeferred']>>;
export type ReceiveOperationRedeemDeferredFilter = Parameters<ReceiveOps['redeemDeferred']>[0];

export interface UseReceiveOperationResult extends OperationHookResult<
  ReceiveOperation,
  ReceiveOperationExecuteResult
> {
  prepare(input: ReceiveOperationPrepareInput): Promise<ReceiveOperationPrepareResult>;
  execute(): Promise<ReceiveOperationExecuteResult>;
  cancel(): Promise<void>;
  listPrepared(): Promise<ReceiveOperationListPreparedResult>;
  listDeferred(): Promise<ReceiveOperationListDeferredResult>;
  redeemDeferred(filter?: ReceiveOperationRedeemDeferredFilter): Promise<void>;
  listInFlight(): Promise<ReceiveOperation[]>;
}

export function useReceiveOperation(
  initialBinding?: OperationBinding<ReceiveOperation> | null,
): UseReceiveOperationResult {
  const manager = useManager();
  const initialBindingRef = useRef(initialBinding);
  const boundOperationIdRef = useRef<string | null>(
    getInitialOperationIdFromBinding(initialBindingRef.current),
  );
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
  } = useOperationHookState<ReceiveOperation, ReceiveOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const bindOperation = useCallback(
    (
      operation: ReceiveOperation | null,
      options?: Parameters<typeof replaceCurrentOperation>[1],
    ) => {
      if (!operation) {
        boundOperationIdRef.current = null;
        replaceCurrentOperation(null, options);
        return;
      }

      if (boundOperationIdRef.current && boundOperationIdRef.current !== operation.id) {
        return;
      }

      if (!shouldReplaceBoundOperation(getCurrentOperation(), operation)) {
        return;
      }

      boundOperationIdRef.current = operation.id;
      replaceCurrentOperation(operation, options);
    },
    [getCurrentOperation, replaceCurrentOperation],
  );

  const handleObservedOperation = useCallback(
    (operation: ReceiveOperation) => {
      if (operation.id === boundOperationIdRef.current) {
        bindOperation(operation);
      }
    },
    [bindOperation],
  );

  const hydrateInitialOperation = useCallback(
    async (operationId: string): Promise<void> => {
      try {
        await runStatefulAction(
          async () => requireOperation((id) => manager.ops.receive.get(id), operationId),
          async (operation) => {
            if (boundOperationIdRef.current !== operationId) {
              return;
            }

            bindOperation(operation, { clearExecuteResult: true });
          },
        );
      } catch (error) {
        if (boundOperationIdRef.current === operationId && !getCurrentOperation()) {
          boundOperationIdRef.current = null;
        }

        throw error;
      }
    },
    [bindOperation, getCurrentOperation, manager, runStatefulAction],
  );

  useInitialOperationHydration(initialBindingRef.current, hydrateInitialOperation);

  useEffect(() => {
    const unsubscribePrepared = manager.on('receive-op:prepared', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeDeferred = manager.on('receive-op:deferred', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeFinalized = manager.on('receive-op:finalized', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeRolledBack = manager.on('receive-op:rolled-back', ({ operation }) => {
      handleObservedOperation(operation);
    });

    return () => {
      unsubscribePrepared();
      unsubscribeDeferred();
      unsubscribeFinalized();
      unsubscribeRolledBack();
    };
  }, [handleObservedOperation, manager]);

  const prepare = useCallback(
    async (input: ReceiveOperationPrepareInput): Promise<ReceiveOperationPrepareResult> => {
      requireUnboundOperationCreation(boundOperationIdRef.current, 'prepare');

      return runStatefulAction(
        async () => manager.ops.receive.prepare(input),
        async (operation) => {
          bindOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [bindOperation, manager, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<ReceiveOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.receive.refresh(targetOperationId),
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const execute = useCallback(async (): Promise<ReceiveOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.receive.execute(targetOperationId),
      async (operation) => {
        bindOperation(operation);
        replaceExecuteResult(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, replaceExecuteResult, runStatefulAction]);

  const cancel = useCallback(async (): Promise<void> => {
    const currentOperation = getCurrentOperation();
    const targetOperationId = requireCurrentOperationId(currentOperation, 'cancel');

    await runStatefulAction(
      async () => {
        await manager.ops.receive.cancel(targetOperationId);
        return {
          operationBeforeCancel: currentOperation,
          operationAfterCancel: await manager.ops.receive.get(targetOperationId),
        };
      },
      async ({ operationBeforeCancel, operationAfterCancel }) => {
        if (operationAfterCancel) {
          bindOperation(operationAfterCancel, { clearExecuteResult: true });
          return;
        }

        if (operationBeforeCancel?.state === 'init' || operationBeforeCancel?.state === 'deferred') {
          bindOperation(null, { clearExecuteResult: true });
          return;
        }

        throw new Error(`Operation ${targetOperationId} not found`);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const listPrepared = useCallback(async (): Promise<ReceiveOperationListPreparedResult> => {
    return manager.ops.receive.listPrepared();
  }, [manager]);

  const listDeferred = useCallback(async (): Promise<ReceiveOperationListDeferredResult> => {
    return manager.ops.receive.listDeferred();
  }, [manager]);

  const redeemDeferred = useCallback(
    async (filter?: ReceiveOperationRedeemDeferredFilter): Promise<void> => {
      return manager.ops.receive.redeemDeferred(filter);
    },
    [manager],
  );

  const listInFlight = useCallback(async (): Promise<ReceiveOperation[]> => {
    return manager.ops.receive.listInFlight();
  }, [manager]);

  const resetBoundOperation = useCallback(() => {
    boundOperationIdRef.current = null;
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
    refresh,
    execute,
    cancel,
    listPrepared,
    listDeferred,
    redeemDeferred,
    listInFlight,
    reset: resetBoundOperation,
  };
}
