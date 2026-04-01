import type { Manager } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
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
    reset,
  } = useOperationHookState<MintOperation, MintOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const load = useCallback(
    async (operationId: string): Promise<MintOperation> => {
      return runStatefulAction(
        async () => requireOperation((id) => manager.ops.mint.get(id), operationId),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  useEffect(() => {
    const binding = initialBindingRef.current;
    if (typeof binding === 'string') {
      void load(binding).catch(() => {});
    }
  }, [load]);

  const prepare = useCallback(
    async (input: MintOperationPrepareInput): Promise<MintOperationPrepareResult> => {
      return runStatefulAction(
        async () => manager.ops.mint.prepare(input),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  const importQuote = useCallback(
    async (input: MintOperationImportQuoteInput): Promise<MintOperationPrepareResult> => {
      return runStatefulAction(
        async () => manager.ops.mint.importQuote(input),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<MintOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.mint.refresh(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const execute = useCallback(async (): Promise<MintOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.mint.execute(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
        replaceExecuteResult(operation);
      },
    );
  }, [
    getCurrentOperation,
    manager,
    replaceCurrentOperation,
    replaceExecuteResult,
    runStatefulAction,
  ]);

  const checkPayment = useCallback(async (): Promise<MintOperationCheckPaymentResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'checkPayment');

    return runStatefulAction(
      async () => manager.ops.mint.checkPayment(targetOperationId),
      async () => {
        const latestOperation = await requireOperation(
          (id) => manager.ops.mint.get(id),
          targetOperationId,
        );
        replaceCurrentOperation(latestOperation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const finalize = useCallback(async (): Promise<MintOperationFinalizeResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'finalize');

    return runStatefulAction(
      async () => manager.ops.mint.finalize(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const listPending = useCallback(async (): Promise<MintOperationPendingList> => {
    return manager.ops.mint.listPending();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<MintOperation[]> => {
    return manager.ops.mint.listInFlight();
  }, [manager]);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading,
    isError,
    prepare,
    importQuote,
    load,
    refresh,
    execute,
    checkPayment,
    finalize,
    listPending,
    listInFlight,
    reset,
  };
}
