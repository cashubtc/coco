import type {
  SendOperation,
  PreparedSendOperation,
  PendingSendOperation,
  Manager,
} from 'coco-cashu-core';
import { useManager } from '../contexts/ManagerContext';
import { useCallback, useEffect, useRef, useState } from 'react';

type Token = Awaited<ReturnType<Manager['wallet']['send']>>;

type SendStatus = 'idle' | 'loading' | 'success' | 'error';

type SendOptions = {
  onSuccess?: (token: Token) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type PrepareOptions = {
  onSuccess?: (operation: PreparedSendOperation) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type ExecuteOptions = {
  onSuccess?: (result: { operation: PendingSendOperation; token: Token }) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type OperationOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

/**
 * Result data type - can be Token (from send/executePreparedSend) or PreparedSendOperation (from prepareSend)
 */
type SendData = Token | PreparedSendOperation | { operation: PendingSendOperation; token: Token };

const useSend = () => {
  const manager = useManager();
  const [status, setStatus] = useState<SendStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<SendData | null>(null);

  const mountedRef = useRef(true);
  const isOperationInProgressRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * @deprecated Use `prepareSend()` followed by `executePreparedSend()` for better control over the send flow.
   * This method will be removed in a future version.
   *
   * Sends ecash tokens in a single step. This is a high-level method that
   * orchestrates the full send flow (init → prepare → execute).
   *
   * @param mintUrl - The mint URL to send from
   * @param amount - The amount to send
   * @param opts - Optional callbacks for success, error, and settled states
   * @returns The token to share with the recipient
   */
  const send = useCallback(
    async (mintUrl: string, amount: number, opts: SendOptions = {}): Promise<Token> => {
      if (isOperationInProgressRef.current) {
        const err = new Error('Operation already in progress');
        opts.onError?.(err);
        throw err;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Amount must be a positive number');
        opts.onError?.(err);
        throw err;
      }

      isOperationInProgressRef.current = true;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        const token = await manager.wallet.send(mintUrl, amount);
        if (mountedRef.current) {
          setData(token);
          setStatus('success');
        }
        opts.onSuccess?.(token);
        return token;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        opts.onError?.(err);
        throw err;
      } finally {
        isOperationInProgressRef.current = false;
        opts.onSettled?.();
      }
    },
    [manager],
  );

  /**
   * Prepares a send operation without executing it.
   * This reserves proofs and calculates the fee, allowing the UI to show
   * the fee to the user before committing.
   *
   * After reviewing, call `executePreparedSend()` to execute, or `rollback()` to cancel.
   *
   * @param mintUrl - The mint URL to send from
   * @param amount - The amount to send
   * @param opts - Optional callbacks for success, error, and settled states
   * @returns The prepared operation with fee information
   */
  const prepareSend = useCallback(
    async (
      mintUrl: string,
      amount: number,
      opts: PrepareOptions = {},
    ): Promise<PreparedSendOperation> => {
      if (isOperationInProgressRef.current) {
        const err = new Error('Operation already in progress');
        opts.onError?.(err);
        throw err;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Amount must be a positive number');
        opts.onError?.(err);
        throw err;
      }

      isOperationInProgressRef.current = true;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        const operation = await manager.send.prepareSend(mintUrl, amount);
        if (mountedRef.current) {
          setData(operation);
          setStatus('success');
        }
        opts.onSuccess?.(operation);
        return operation;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        opts.onError?.(err);
        throw err;
      } finally {
        isOperationInProgressRef.current = false;
        opts.onSettled?.();
      }
    },
    [manager],
  );

  /**
   * Executes a previously prepared send operation.
   * Call this after `prepareSend()` to complete the send and get the token.
   *
   * @param operationId - The ID of the prepared operation
   * @param opts - Optional callbacks for success, error, and settled states
   * @returns The pending operation and the token to share
   */
  const executePreparedSend = useCallback(
    async (
      operationId: string,
      opts: ExecuteOptions = {},
    ): Promise<{ operation: PendingSendOperation; token: Token }> => {
      if (isOperationInProgressRef.current) {
        const err = new Error('Operation already in progress');
        opts.onError?.(err);
        throw err;
      }

      isOperationInProgressRef.current = true;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        const result = await manager.send.executePreparedSend(operationId);
        if (mountedRef.current) {
          setData(result);
          setStatus('success');
        }
        opts.onSuccess?.(result);
        return result;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        opts.onError?.(err);
        throw err;
      } finally {
        isOperationInProgressRef.current = false;
        opts.onSettled?.();
      }
    },
    [manager],
  );

  /**
   * Rolls back a send operation by reclaiming the proofs.
   * Can be called on operations in 'prepared', 'executing', or 'pending' state.
   *
   * @param operationId - The ID of the operation to rollback
   * @param opts - Optional callbacks for success, error, and settled states
   */
  const rollback = useCallback(
    async (operationId: string, opts: OperationOptions = {}): Promise<void> => {
      try {
        await manager.send.rollback(operationId);
        opts.onSuccess?.();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        opts.onError?.(err);
        throw err;
      } finally {
        opts.onSettled?.();
      }
    },
    [manager],
  );

  /**
   * Finalizes a send operation after its proofs have been spent.
   * This marks the operation as completed.
   *
   * @param operationId - The ID of the operation to finalize
   * @param opts - Optional callbacks for success, error, and settled states
   */
  const finalize = useCallback(
    async (operationId: string, opts: OperationOptions = {}): Promise<void> => {
      try {
        await manager.send.finalize(operationId);
        opts.onSuccess?.();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        opts.onError?.(err);
        throw err;
      } finally {
        opts.onSettled?.();
      }
    },
    [manager],
  );

  /**
   * Gets all pending send operations.
   * Pending operations are in 'executing' or 'pending' state.
   *
   * @returns Array of pending send operations
   */
  const getPendingOperations = useCallback(async (): Promise<SendOperation[]> => {
    return manager.send.getPendingOperations();
  }, [manager]);

  /**
   * Gets a send operation by its ID.
   *
   * @param operationId - The ID of the operation to retrieve
   * @returns The send operation or null if not found
   */
  const getOperation = useCallback(
    async (operationId: string): Promise<SendOperation | null> => {
      return manager.send.getOperation(operationId);
    },
    [manager],
  );

  /**
   * Resets the hook state to idle.
   */
  const reset = useCallback(() => {
    if (!mountedRef.current) return;
    setStatus('idle');
    setError(null);
    setData(null);
  }, []);

  return {
    // Two-step flow (recommended)
    prepareSend,
    executePreparedSend,

    // Operation management
    rollback,
    finalize,
    getPendingOperations,
    getOperation,

    // State
    status,
    data,
    error,
    reset,

    // Convenience booleans
    isSending: status === 'loading',
    isError: status === 'error',

    /**
     * @deprecated Use `prepareSend()` followed by `executePreparedSend()` instead.
     */
    send,
  };
};

export default useSend;
