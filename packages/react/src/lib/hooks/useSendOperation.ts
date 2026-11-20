import type { Manager, PreparedSendOperation, SendOperation } from '@cashu/coco-core';
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  getInitialOperationIdFromBinding,
  requireCurrentOperationId,
  requireOperation,
  requireUnboundOperationCreation,
  useInitialOperationHydration,
  useOperationActionState,
} from './operationHookUtils';
import { sendOperationKind } from './operationKinds';
import { getOperationStore, newerOperation } from './operationStore';

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

/**
 * The Send this hook instance follows. `record` holds what this instance itself received (an
 * operation object passed as the binding or an action result), so the hook can display it before
 * its store subscription exists. The shared store supplies everything observed after that.
 * `record` counts only while `manager` is still the hook's Manager, so a record never outlives a
 * Manager change even when the next Manager has an operation with the same ID.
 */
type SendSelection = {
  id: string;
  record: SendOperation | null;
  manager: Manager;
};

const unsubscribeNothing = () => {};
const subscribeNothing = () => unsubscribeNothing;

function getInitialSelection(
  binding: OperationBinding<SendOperation> | null | undefined,
  manager: Manager,
): SendSelection | null {
  const id = getInitialOperationIdFromBinding(binding);
  return id ? { id, record: getInitialOperationFromBinding(binding), manager } : null;
}

function ownRecordFor(selection: SendSelection | null, manager: Manager): SendOperation | null {
  return selection?.manager === manager ? selection.record : null;
}

export function useSendOperation(
  initialBinding?: OperationBinding<SendOperation> | null,
): UseSendOperationResult {
  const manager = useManager();
  const store = useMemo(() => getOperationStore(manager, sendOperationKind), [manager]);
  const initialBindingRef = useRef(initialBinding);
  const [selection, setSelection] = useState(() => getInitialSelection(initialBinding, manager));
  const selectionRef = useRef(selection);
  const {
    executeResult,
    status,
    error,
    isLoading,
    isError,
    isMounted,
    replaceExecuteResult,
    runStatefulAction,
    runHydration,
    resetActionState,
  } = useOperationActionState<SendOperationExecuteResult>();

  const selectedId = selection?.id ?? null;
  const subscribe = useCallback(
    (listener: () => void) =>
      selectedId ? store.subscribe(selectedId, listener) : subscribeNothing(),
    [selectedId, store],
  );
  const getSnapshot = useCallback(
    () => (selectedId ? store.getSnapshot(selectedId) : null),
    [selectedId, store],
  );
  const observedOperation = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const currentOperation = newerOperation(
    sendOperationKind,
    observedOperation,
    ownRecordFor(selection, manager),
  );

  const select = useCallback(
    (next: SendSelection | null) => {
      if (!isMounted()) {
        return;
      }

      selectionRef.current = next;
      setSelection(next);
    },
    [isMounted],
  );

  const getCurrentOperation = useCallback((): SendOperation | null => {
    const current = selectionRef.current;
    if (!current) {
      return null;
    }

    return newerOperation(
      sendOperationKind,
      store.getSnapshot(current.id),
      ownRecordFor(current, manager),
    );
  }, [manager, store]);

  /** Shows a record this instance received from `source` if it still follows that ID. */
  const keepOwnRecord = useCallback(
    (operation: SendOperation, source: Manager) => {
      const current = selectionRef.current;
      if (current?.id !== operation.id) {
        return;
      }

      const record =
        current.manager === source
          ? newerOperation(sendOperationKind, current.record, operation)
          : operation;
      if (record !== current.record || current.manager !== source) {
        select({ id: current.id, record, manager: source });
      }
    },
    [select],
  );

  const hydrateInitialOperation = useCallback(
    (operationId: string): Promise<void> =>
      runHydration(
        operationId,
        {
          read: () => requireOperation((id) => store.read(id), operationId),
          // The store has already shared the record with every observer of this ID.
          onLoaded: () => {},
          onFailed: () => {
            if (selectionRef.current?.id === operationId && !getCurrentOperation()) {
              select(null);
            }
          },
        },
        store,
      ),
    [getCurrentOperation, runHydration, select, store],
  );

  useInitialOperationHydration(initialBindingRef.current, hydrateInitialOperation);

  /**
   * Runs a command for the selected Send. Its resulting record reaches every observer of that ID
   * through the store of the Manager that ran it, even after this hook was reset.
   */
  const runSelectedAction = useCallback(
    async <T>(
      actionName: string,
      action: (operationId: string) => Promise<T>,
      recordOf: (result: T) => SendOperation,
      onSuccess?: (result: T) => void,
    ): Promise<T> => {
      const operationId = requireCurrentOperationId(getCurrentOperation(), actionName);

      return runStatefulAction(
        async () => {
          const result = await action(operationId);
          store.observe(recordOf(result));
          return result;
        },
        (result) => {
          keepOwnRecord(recordOf(result), manager);
          onSuccess?.(result);
        },
      );
    },
    [getCurrentOperation, keepOwnRecord, manager, runStatefulAction, store],
  );

  /** Settles a command, then rereads the Send so observers see the state it left behind. */
  const settleAndReread = useCallback(
    async (operationId: string, command: (operationId: string) => Promise<void>) => {
      await command(operationId);
      return requireOperation((id) => manager.ops.send.get(id), operationId);
    },
    [manager],
  );

  const prepare = useCallback(
    async (input: SendOperationPrepareInput): Promise<PreparedSendOperation> => {
      requireUnboundOperationCreation(selectionRef.current?.id ?? null, 'prepare');

      return runStatefulAction(
        async () => manager.ops.send.prepare(input),
        (operation) => {
          if (!selectionRef.current) {
            replaceExecuteResult(null);
            select({ id: operation.id, record: operation, manager });
          }
        },
      );
    },
    [manager, replaceExecuteResult, runStatefulAction, select],
  );

  const refresh = useCallback(
    (): Promise<SendOperation> =>
      runSelectedAction(
        'refresh',
        (id) => manager.ops.send.refresh(id),
        (operation) => operation,
      ),
    [manager, runSelectedAction],
  );

  const execute = useCallback(
    (): Promise<SendOperationExecuteResult> =>
      runSelectedAction(
        'execute',
        (id) => manager.ops.send.execute(id),
        (result) => result.operation,
        replaceExecuteResult,
      ),
    [manager, replaceExecuteResult, runSelectedAction],
  );

  const cancel = useCallback(async (): Promise<void> => {
    await runSelectedAction(
      'cancel',
      (id) => settleAndReread(id, (operationId) => manager.ops.send.cancel(operationId)),
      (operation) => operation,
      () => replaceExecuteResult(null),
    );
  }, [manager, replaceExecuteResult, runSelectedAction, settleAndReread]);

  const reclaim = useCallback(async (): Promise<void> => {
    await runSelectedAction(
      'reclaim',
      (id) => settleAndReread(id, (operationId) => manager.ops.send.reclaim(operationId)),
      (operation) => operation,
      () => replaceExecuteResult(null),
    );
  }, [manager, replaceExecuteResult, runSelectedAction, settleAndReread]);

  const finalize = useCallback(async (): Promise<void> => {
    await runSelectedAction(
      'finalize',
      (id) => settleAndReread(id, (operationId) => manager.ops.send.finalize(operationId)),
      (operation) => operation,
    );
  }, [manager, runSelectedAction, settleAndReread]);

  const listPrepared = useCallback(async (): Promise<PreparedSendOperation[]> => {
    return manager.ops.send.listPrepared();
  }, [manager]);

  const listInFlight = useCallback(async (): Promise<SendOperation[]> => {
    return manager.ops.send.listInFlight();
  }, [manager]);

  const reset = useCallback(() => {
    if (!isMounted()) {
      return;
    }

    select(null);
    resetActionState();
  }, [isMounted, resetActionState, select]);

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
    reset,
  };
}
