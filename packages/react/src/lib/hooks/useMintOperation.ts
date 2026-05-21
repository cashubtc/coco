import type { Manager } from '@cashu/coco-core';
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

type MintOps = Manager['ops']['mint'];
type MintOperation = NonNullable<Awaited<ReturnType<MintOps['get']>>>;

export type MintOperationPrepareInput = Parameters<MintOps['prepare']>[0];
export type MintOperationImportQuoteInput = Parameters<MintOps['importQuote']>[0];
export type MintOperationPrepareResult = Awaited<ReturnType<MintOps['prepare']>>;
export type MintOperationExecuteResult = Awaited<ReturnType<MintOps['execute']>>;
export type MintOperationCheckPaymentResult = Awaited<ReturnType<MintOps['checkPayment']>>;
export type MintOperationFinalizeResult = Awaited<ReturnType<MintOps['finalize']>>;
export type MintOperationPendingList = Awaited<ReturnType<MintOps['listPending']>>;

export interface UseMintOperationResult extends OperationHookResult<
  MintOperation,
  MintOperationExecuteResult
> {
  prepare(input: MintOperationPrepareInput): Promise<MintOperationPrepareResult>;
  importQuote(input: MintOperationImportQuoteInput): Promise<MintOperationPrepareResult>;
  execute(): Promise<MintOperationExecuteResult>;
  checkPayment(): Promise<MintOperationCheckPaymentResult>;
  finalize(): Promise<MintOperationFinalizeResult>;
  listPending(): Promise<MintOperationPendingList>;
  listInFlight(): Promise<MintOperation[]>;
}

export function useMintOperation(
  initialBinding?: OperationBinding<MintOperation> | null,
): UseMintOperationResult {
  const manager = useManager();
  const initialBindingRef = useRef(initialBinding);
  const initialOperation = getInitialOperationFromBinding(initialBindingRef.current);
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
  } = useOperationHookState<MintOperation, MintOperationExecuteResult>(initialOperation);

  const bindOperation = useCallback(
    (operation: MintOperation | null, options?: Parameters<typeof replaceCurrentOperation>[1]) => {
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
    (operation: MintOperation) => {
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
          async () => requireOperation((id) => manager.ops.mint.get(id), operationId),
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
    const unsubscribePending = manager.on('mint-op:pending', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeExecuting = manager.on('mint-op:executing', ({ operation }) => {
      handleObservedOperation(operation);
    });
    const unsubscribeFinalized = manager.on('mint-op:finalized', ({ operation }) => {
      handleObservedOperation(operation);
    });

    return () => {
      unsubscribePending();
      unsubscribeExecuting();
      unsubscribeFinalized();
    };
  }, [handleObservedOperation, manager]);

  const prepare = useCallback(
    async (input: MintOperationPrepareInput): Promise<MintOperationPrepareResult> => {
      requireUnboundOperationCreation(boundOperationIdRef.current, 'prepare');

      return runStatefulAction(
        async () => manager.ops.mint.prepare(input),
        async (operation) => {
          bindOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [bindOperation, manager, runStatefulAction],
  );

  const importQuote = useCallback(
    async (input: MintOperationImportQuoteInput): Promise<MintOperationPrepareResult> => {
      requireUnboundOperationCreation(boundOperationIdRef.current, 'importQuote');

      return runStatefulAction(
        async () => manager.ops.mint.importQuote(input),
        async (operation) => {
          bindOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [bindOperation, manager, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<MintOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.mint.refresh(targetOperationId),
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const execute = useCallback(async (): Promise<MintOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.mint.execute(targetOperationId),
      async (operation) => {
        bindOperation(operation);
        replaceExecuteResult(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, replaceExecuteResult, runStatefulAction]);

  const checkPayment = useCallback(async (): Promise<MintOperationCheckPaymentResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'checkPayment');

    return runStatefulAction(
      async () => manager.ops.mint.checkPayment(targetOperationId),
      async () => {
        const latestOperation = await requireOperation(
          (id) => manager.ops.mint.get(id),
          targetOperationId,
        );
        bindOperation(latestOperation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const finalize = useCallback(async (): Promise<MintOperationFinalizeResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'finalize');

    return runStatefulAction(
      async () => manager.ops.mint.finalize(targetOperationId),
      async (operation) => {
        bindOperation(operation);
      },
    );
  }, [bindOperation, getCurrentOperation, manager, runStatefulAction]);

  const listPending = useCallback(async (): Promise<MintOperationPendingList> => {
    return manager.ops.mint.listPending();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<MintOperation[]> => {
    return manager.ops.mint.listInFlight();
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
    importQuote,
    refresh,
    execute,
    checkPayment,
    finalize,
    listPending,
    listInFlight,
    reset: resetBoundOperation,
  };
}
