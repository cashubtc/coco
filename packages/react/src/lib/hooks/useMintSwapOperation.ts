import { useCallback, useEffect, useRef } from 'react';

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

export type MintSwapOperationView = {
  id: string;
  revision: number;
  updatedAt: number;
  state: string;
  [key: string]: unknown;
};

export interface MintSwapClient<TOperation extends MintSwapOperationView = MintSwapOperationView> {
  prepare(input: unknown): Promise<TOperation>;
  execute(operationId: string): Promise<TOperation>;
  reconcile(operationId: string): Promise<TOperation>;
  cancel(operationId: string, reason?: string): Promise<TOperation>;
  get(operationId: string): Promise<TOperation | null>;
  list(input?: unknown): Promise<TOperation[]>;
}

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

export interface MintSwapEventSource {
  on(
    event: MintSwapEvent,
    handler: (payload: { operationId: string; revision: number }) => void | Promise<void>,
  ): () => void;
}

export interface UseMintSwapOperationResult<
  TOperation extends MintSwapOperationView,
> extends OperationHookResult<TOperation, TOperation> {
  prepare(input: unknown): Promise<TOperation>;
  execute(): Promise<TOperation>;
  reconcile(): Promise<TOperation>;
  cancel(reason?: string): Promise<TOperation>;
  list(input?: unknown): Promise<TOperation[]>;
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

export function useMintSwapOperation<TOperation extends MintSwapOperationView>(
  client: MintSwapClient<TOperation>,
  events: MintSwapEventSource,
  initialBinding?: OperationBinding<TOperation> | null,
): UseMintSwapOperationResult<TOperation> {
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
  } = useOperationHookState<TOperation, TOperation>(
    getInitialOperationFromBinding(initialBindingRef.current),
  );

  const bind = useCallback(
    (operation: TOperation | null, clearExecuteResult = false) => {
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
    const offs = EVENTS.map((event) => events.on(event, observe));
    return () => {
      active = false;
      for (const off of offs) off();
    };
  }, [bind, client, events, getCurrentOperation]);

  const prepare = useCallback(
    (input: unknown) => {
      requireUnboundOperationCreation(boundIdRef.current, 'prepare');
      return runStatefulAction(
        () => client.prepare(input),
        (operation) => bind(operation, true),
      );
    },
    [bind, client, runStatefulAction],
  );
  const runBound = useCallback(
    (action: (operationId: string) => Promise<TOperation>) => {
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
    refresh: reconcile,
    cancel,
    list: client.list,
    reset,
  };
}
