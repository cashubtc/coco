import type { Manager, ReceiveOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
  useOperationHookState,
} from './operationHookUtils';

type ReceiveOps = Manager['ops']['receive'];

export type ReceiveOperationPrepareInput = Parameters<ReceiveOps['prepare']>[0];
export type ReceiveOperationPrepareResult = Awaited<ReturnType<ReceiveOps['prepare']>>;
export type ReceiveOperationExecuteResult = Awaited<ReturnType<ReceiveOps['execute']>>;

export interface UseReceiveOperationResult extends OperationHookResult<
  ReceiveOperation,
  ReceiveOperationExecuteResult
> {
  prepare(input: ReceiveOperationPrepareInput): Promise<ReceiveOperationPrepareResult>;
  execute(): Promise<ReceiveOperationExecuteResult>;
  cancel(): Promise<void>;
  listPrepared(): Promise<ReceiveOperationPrepareResult[]>;
  listInFlight(): Promise<ReceiveOperation[]>;
}

export function useReceiveOperation(
  initialBinding?: OperationBinding<ReceiveOperation> | null,
): UseReceiveOperationResult {
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
  } = useOperationHookState<ReceiveOperation, ReceiveOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const load = useCallback(
    async (operationId: string): Promise<ReceiveOperation> => {
      return runStatefulAction(
        async () => requireOperation((id) => manager.ops.receive.get(id), operationId),
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
    async (input: ReceiveOperationPrepareInput): Promise<ReceiveOperationPrepareResult> => {
      return runStatefulAction(
        async () => manager.ops.receive.prepare(input),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<ReceiveOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.receive.refresh(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const execute = useCallback(async (): Promise<ReceiveOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.receive.execute(targetOperationId),
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
          replaceCurrentOperation(operationAfterCancel, { clearExecuteResult: true });
          return;
        }

        if (operationBeforeCancel?.state === 'init') {
          replaceCurrentOperation(null, { clearExecuteResult: true });
          return;
        }

        throw new Error(`Operation ${targetOperationId} not found`);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const listPrepared = useCallback(async (): Promise<ReceiveOperationPrepareResult[]> => {
    return manager.ops.receive.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<ReceiveOperation[]> => {
    return manager.ops.receive.listInFlight();
  }, [manager]);

  return {
    currentOperation,
    executeResult,
    status,
    error,
    isLoading,
    isError,
    prepare,
    load,
    refresh,
    execute,
    cancel,
    listPrepared,
    listInFlight,
    reset,
  };
}
