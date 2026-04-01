import type { Manager, PreparedSendOperation, SendOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  requireCurrentOperationId,
  requireOperation,
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
  } = useOperationHookState<SendOperation, SendOperationExecuteResult>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const load = useCallback(
    async (operationId: string): Promise<SendOperation> => {
      return runStatefulAction(
        async () => requireOperation((id) => manager.ops.send.get(id), operationId),
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
    async (input: SendOperationPrepareInput): Promise<PreparedSendOperation> => {
      return runStatefulAction(
        async () => manager.ops.send.prepare(input),
        async (operation) => {
          replaceCurrentOperation(operation, { clearExecuteResult: true });
        },
      );
    },
    [manager, replaceCurrentOperation, runStatefulAction],
  );

  const refresh = useCallback(async (): Promise<SendOperation> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'refresh');

    return runStatefulAction(
      async () => manager.ops.send.refresh(targetOperationId),
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const execute = useCallback(async (): Promise<SendOperationExecuteResult> => {
    const targetOperationId = requireCurrentOperationId(getCurrentOperation(), 'execute');

    return runStatefulAction(
      async () => manager.ops.send.execute(targetOperationId),
      async (result) => {
        replaceCurrentOperation(result.operation);
        replaceExecuteResult(result);
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
        await manager.ops.send.cancel(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
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
        await manager.ops.send.reclaim(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
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
        await manager.ops.send.finalize(targetOperationId);
        return requireOperation((id) => manager.ops.send.get(id), targetOperationId);
      },
      async (operation) => {
        replaceCurrentOperation(operation);
      },
    );
  }, [getCurrentOperation, manager, replaceCurrentOperation, runStatefulAction]);

  const listPrepared = useCallback(async (): Promise<PreparedSendOperation[]> => {
    return manager.ops.send.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<SendOperation[]> => {
    return manager.ops.send.listInFlight();
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
