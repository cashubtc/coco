import type { Manager, PreparedSendOperation, SendOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationIdFromBinding,
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
  useInitialOperationHydration,
  useOperationHookState,
} from './operationHookUtils';

type SendOps = Manager['ops']['send'];

export type SendOperationPrepareInput = Parameters<SendOps['prepare']>[0];
export type SendOperationExecuteResult = Awaited<ReturnType<SendOps['execute']>>;

export interface UseSendOperationResult extends OperationHookResult<
  SendOperation,
  SendOperationExecuteResult
> {
  prepare(input: SendOperationPrepareInput): Promise<PreparedSendOperation>;
  execute(): Promise<SendOperationExecuteResult>;
  cancel(): Promise<void>;
  reclaim(): Promise<void>;
  finalize(): Promise<void>;
  listPrepared(): Promise<PreparedSendOperation[]>;
  listInFlight(): Promise<SendOperation[]>;
}

export function useSendOperation(
  initialBinding?: OperationBinding<SendOperation> | null,
): UseSendOperationResult {
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
  } = useOperationHookState<SendOperation, SendOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const bindOperation = useCallback(
    (
      operation: SendOperation | null,
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

      boundOperationIdRef.current = operation.id;
      replaceCurrentOperation(operation, options);
    },
    [replaceCurrentOperation],
  );

  const handleObservedOperation = useCallback(
    (operation: SendOperation) => {
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
          async () => requireOperation((id) => manager.ops.send.get(id), operationId),
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
    const unsubscribePrepared = manager.on('send:prepared', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribePending = manager.on('send:pending', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeFinalized = manager.on('send:finalized', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeRolledBack = manager.on('send:rolled-back', ({ operation }) => {
      handleObservedOperation(operation);
    });

    return () => {
      unsubscribePrepared();
      unsubscribePending();
      unsubscribeFinalized();
      unsubscribeRolledBack();
    };
  }, [handleObservedOperation, manager]);

  const prepare = useCallback(
    async (input: SendOperationPrepareInput): Promise<PreparedSendOperation> => {
      return runStatefulAction(
        async () => manager.ops.send.prepare(input),
        async (operation) => {
          bindOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [bindOperation, manager, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<SendOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.send.refresh(targetOperationId),
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const execute = useCallback(async (): Promise<SendOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.send.execute(targetOperationId),
      async (result) => {
        bindOperation(result.operation);
        replaceExecuteResult(result);
      },
    );
  }, [
    bindOperation,
    getCurrentOperation,
    manager,
    replaceExecuteResult,
    runStatefulAction,
  ]);

  const cancel = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'cancel');

    await runStatefulAction(
      async () => {
        await manager.ops.send.cancel(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
      },
      async (operation) => {
        bindOperation(operation, { clearExecuteResult: true });
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const reclaim = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'reclaim');

    await runStatefulAction(
      async () => {
        await manager.ops.send.reclaim(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
      },
      async (operation) => {
        bindOperation(operation, { clearExecuteResult: true });
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const finalize = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'finalize');

    await runStatefulAction(
      async () => {
        await manager.ops.send.finalize(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
      },
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const listPrepared = useCallback(async (): Promise<PreparedSendOperation[]> => {
    return manager.ops.send.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<SendOperation[]> => {
    return manager.ops.send.listInFlight();
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
    reclaim,
    finalize,
    listPrepared,
    listInFlight,
    reset: resetBoundOperation,
  };
}
