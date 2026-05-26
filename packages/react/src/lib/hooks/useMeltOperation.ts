import type { Manager, MeltOperation } from '@cashu/coco-core';
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

type MeltOps = Manager['ops']['melt'];

export type MeltOperationPrepareInput = Parameters<MeltOps['prepare']>[0];
export type MeltOperationGetByQuoteInput = Parameters<MeltOps['getByQuote']>[0];
export type MeltOperationListByQuoteInput = Parameters<MeltOps['listByQuote']>[0];
export type MeltOperationPrepareResult = Awaited<ReturnType<MeltOps['prepare']>>;
export type MeltOperationExecuteResult = Awaited<ReturnType<MeltOps['execute']>>;
export type MeltOperationByQuoteResult = Awaited<ReturnType<MeltOps['getByQuote']>>;
export type MeltOperationListByQuoteResult = Awaited<ReturnType<MeltOps['listByQuote']>>;

export interface UseMeltOperationResult extends OperationHookResult<
  MeltOperation,
  MeltOperationExecuteResult
> {
  prepare(input: MeltOperationPrepareInput): Promise<MeltOperationPrepareResult>;
  execute(): Promise<MeltOperationExecuteResult>;
  cancel(): Promise<void>;
  reclaim(): Promise<void>;
  finalize(): Promise<void>;
  getByQuote(input: MeltOperationGetByQuoteInput): Promise<MeltOperationByQuoteResult>;
  listByQuote(input: MeltOperationListByQuoteInput): Promise<MeltOperationListByQuoteResult>;
  listPrepared(): Promise<MeltOperationPrepareResult[]>;
  listInFlight(): Promise<MeltOperation[]>;
}

export function useMeltOperation(
  initialBinding?: OperationBinding<MeltOperation> | null,
): UseMeltOperationResult {
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
  } = useOperationHookState<MeltOperation, MeltOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const bindOperation = useCallback(
    (operation: MeltOperation | null, options?: Parameters<typeof replaceCurrentOperation>[1]) => {
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
    (operation: MeltOperation) => {
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
          async () => requireOperation((id) => manager.ops.melt.get(id), operationId),
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
    const unsubscribePrepared = manager.on('melt-op:prepared', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribePending = manager.on('melt-op:pending', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeFinalized = manager.on('melt-op:finalized', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeRolledBack = manager.on('melt-op:rolled-back', ({ operation }) => {
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
    async (input: MeltOperationPrepareInput): Promise<MeltOperationPrepareResult> => {
      requireUnboundOperationCreation(boundOperationIdRef.current, 'prepare');

      return runStatefulAction(
        async () => manager.ops.melt.prepare(input),
        async (operation) => {
          bindOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [bindOperation, manager, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<MeltOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.melt.refresh(targetOperationId),
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const execute = useCallback(async (): Promise<MeltOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.melt.execute(targetOperationId),
      async (operation) => {
        bindOperation(operation);
        replaceExecuteResult(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, replaceExecuteResult, runStatefulAction]);

  const cancel = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'cancel');

    await runStatefulAction(
      async () => {
        await manager.ops.melt.cancel(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
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
        await manager.ops.melt.reclaim(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
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
        await manager.ops.melt.finalize(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
      },
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const getByQuote = useCallback(
    async (input: MeltOperationGetByQuoteInput): Promise<MeltOperationByQuoteResult> => {
      return manager.ops.melt.getByQuote(input);
    },
    [manager],
  );

  const listByQuote = useCallback(
    async (input: MeltOperationListByQuoteInput): Promise<MeltOperationListByQuoteResult> => {
      return manager.ops.melt.listByQuote(input);
    },
    [manager],
  );

  const listPrepared = useCallback(async (): Promise<MeltOperationPrepareResult[]> => {
    return manager.ops.melt.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<MeltOperation[]> => {
    return manager.ops.melt.listInFlight();
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
    getByQuote,
    listByQuote,
    listPrepared,
    listInFlight,
    reset: resetBoundOperation,
  };
}
