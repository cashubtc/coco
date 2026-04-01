import type { Manager, MeltOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
  useOperationHookState,
} from './operationHookUtils';

type MeltOps = Manager['ops']['melt'];

export type MeltOperationPrepareInput = Parameters<MeltOps['prepare']>[0];
export type MeltOperationPrepareResult = Awaited<ReturnType<MeltOps['prepare']>>;
export type MeltOperationExecuteResult = Awaited<ReturnType<MeltOps['execute']>>;

export interface UseMeltOperationResult extends OperationHookResult<
  MeltOperation,
  MeltOperationExecuteResult
> {
  prepare(input: MeltOperationPrepareInput): Promise<MeltOperationPrepareResult>;
  execute(): Promise<MeltOperationExecuteResult>;
  cancel(): Promise<void>;
  reclaim(): Promise<void>;
  finalize(): Promise<void>;
  listPrepared(): Promise<MeltOperationPrepareResult[]>;
  listInFlight(): Promise<MeltOperation[]>;
}

export function useMeltOperation(
  initialBinding?: OperationBinding<MeltOperation> | null,
): UseMeltOperationResult {
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
  } = useOperationHookState<MeltOperation, MeltOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const load = useCallback(
    async (operationId: string): Promise<MeltOperation> => {
      return runStatefulAction(
        async () => requireOperation((id) => manager.ops.melt.get(id), operationId),
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
    async (input: MeltOperationPrepareInput): Promise<MeltOperationPrepareResult> => {
      return runStatefulAction(
        async () => manager.ops.melt.prepare(input),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<MeltOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.melt.refresh(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const execute = useCallback(async (): Promise<MeltOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.melt.execute(targetOperationId),
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
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'cancel');

    await runStatefulAction(
      async () => {
        await manager.ops.melt.cancel(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
      },
      async (operation) => {
        replaceCurrentOperation(operation, { clearExecuteResult: true });
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const reclaim = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'reclaim');

    await runStatefulAction(
      async () => {
        await manager.ops.melt.reclaim(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
      },
      async (operation) => {
        replaceCurrentOperation(operation, { clearExecuteResult: true });
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const finalize = useCallback(async (): Promise<void> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'finalize');

    await runStatefulAction(
      async () => {
        await manager.ops.melt.finalize(targetOperationId);
        return requireOperation((id) => manager.ops.melt.get(id), targetOperationId);
      },
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const listPrepared = useCallback(async (): Promise<MeltOperationPrepareResult[]> => {
    return manager.ops.melt.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<MeltOperation[]> => {
    return manager.ops.melt.listInFlight();
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
    reclaim,
    finalize,
    listPrepared,
    listInFlight,
    reset,
  };
}
