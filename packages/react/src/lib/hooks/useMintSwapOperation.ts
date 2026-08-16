import type { Manager, MintSwapOperation } from '@cashu/coco-core';
import { useCallback, useEffect, useRef } from 'react';

import { useManager } from '../contexts/ManagerContext';
import type { OperationBinding, OperationHookResult } from './operation-types';
import {
  getInitialOperationFromBinding,
  getInitialOperationIdFromBinding,
  requireCurrentOperationId,
  requireOperation,
  requireUnboundOperationCreation,
  shouldReplaceRevisionedOperation,
  useInitialOperationHydration,
  useOperationHookState,
} from './operationHookUtils';

type MintSwapOps = Manager['ops']['mintSwap'];
export type MintSwapPrepareInput = Parameters<MintSwapOps['prepare']>[0];
export type MintSwapListInput = Parameters<MintSwapOps['list']>[0];

type MintSwapEvent =
  | 'mint-swap-op:prepared'
  | 'mint-swap-op:source-inflight'
  | 'mint-swap-op:destination-funded'
  | 'mint-swap-op:issuing'
  | 'mint-swap-op:completed'
  | 'mint-swap-op:cancelled'
  | 'mint-swap-op:failed'
  | 'mint-swap-op:needs-attention'
  | 'mint-swap-op:delayed';

export interface UseMintSwapOperationResult extends Omit<
  OperationHookResult<MintSwapOperation, MintSwapOperation>,
  'refresh'
> {
  prepare(input: MintSwapPrepareInput): Promise<MintSwapOperation>;
  execute(): Promise<MintSwapOperation>;
  reconcile(): Promise<MintSwapOperation>;
  cancel(reason?: string): Promise<MintSwapOperation>;
  list(input?: MintSwapListInput): Promise<MintSwapOperation[]>;
}

const EVENTS: readonly MintSwapEvent[] = [
  'mint-swap-op:prepared',
  'mint-swap-op:source-inflight',
  'mint-swap-op:destination-funded',
  'mint-swap-op:issuing',
  'mint-swap-op:completed',
  'mint-swap-op:cancelled',
  'mint-swap-op:failed',
  'mint-swap-op:needs-attention',
  'mint-swap-op:delayed',
];

export function useMintSwapOperation(
  initialBinding?: OperationBinding<MintSwapOperation> | null,
): UseMintSwapOperationResult {
  const manager = useManager();
  const client = manager.ops.mintSwap;
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
      if (!shouldReplaceRevisionedOperation(getCurrentOperation(), operation)) return;
      boundIdRef.current = operation.id;
      replaceCurrentOperation(operation, { clearExecuteResult });
    },
    [getCurrentOperation, replaceCurrentOperation],
  );

  const hydrate = useCallback(
    async (operationId: string) => {
      const operation = await requireOperation((id) => client.get(id), operationId);
      if (boundIdRef.current === operationId) bind(operation, true);
    },
    [bind, client],
  );
  useInitialOperationHydration(initialBindingRef.current, hydrate);

  useEffect(() => {
    let active = true;
    const observe = async ({
      operationId,
      revision,
    }: {
      operationId: string;
      revision: number;
    }) => {
      if (!active || operationId !== boundIdRef.current) return;
      const current = getCurrentOperation();
      if (current && revision <= current.revision) return;
      const operation = await client.get(operationId);
      if (active && operation) bind(operation);
    };
    const offs = EVENTS.map((event) => manager.on(event, observe));
    return () => {
      active = false;
      for (const off of offs) off();
    };
  }, [bind, client, getCurrentOperation, manager]);

  const prepare = useCallback(
    (input: MintSwapPrepareInput) => {
      requireUnboundOperationCreation(boundIdRef.current, 'prepare');
      return runStatefulAction(
        () => client.prepare(input),
        (operation) => bind(operation, true),
      );
    },
    [bind, client, runStatefulAction],
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
    const operation = await runBound((id) => client.execute(id));
    replaceExecuteResult(operation);
    return operation;
  }, [client, replaceExecuteResult, runBound]);
  const reconcile = useCallback(() => runBound((id) => client.reconcile(id)), [client, runBound]);
  const cancel = useCallback(
    (reason?: string) => runBound((id) => client.cancel(id, reason)),
    [client, runBound],
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
    reconcile,
    cancel,
    list: (input) => client.list(input),
    reset,
  };
}
