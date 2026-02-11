import type {
  SendOperation,
  PreparedSendOperation,
  PendingSendOperation,
  Manager,
} from 'coco-cashu-core';
import { getManagerContext } from '../context.js';

type Token = Awaited<ReturnType<Manager['wallet']['send']>>;

type SendStatus = 'idle' | 'loading' | 'success' | 'error';

export type SendOptions = {
  onSuccess?: (token: Token) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

export type PrepareOptions = {
  onSuccess?: (operation: PreparedSendOperation) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

export type ExecuteOptions = {
  onSuccess?: (result: { operation: PendingSendOperation; token: Token }) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

export type OperationOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

type SendData = Token | PreparedSendOperation | { operation: PendingSendOperation; token: Token };

/**
 * Reactive send composable with two-step flow support.
 *
 * Provides:
 * - `prepareSend()` / `executePreparedSend()` (recommended two-step flow)
 * - `send()` (deprecated single-step)
 * - `rollback()` / `finalize()` / `getPendingOperations()` / `getOperation()`
 * - Reactive `status`, `data`, `error` state
 */
export function useSend() {
  const manager = getManagerContext();

  let status = $state<SendStatus>('idle');
  let error = $state<Error | null>(null);
  let data = $state<SendData | null>(null);
  let inProgress = false;

  /**
   * @deprecated Use `prepareSend()` followed by `executePreparedSend()` instead.
   */
  async function send(mintUrl: string, amount: number, opts: SendOptions = {}): Promise<Token> {
    if (inProgress) {
      const err = new Error('Operation already in progress');
      opts.onError?.(err);
      throw err;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error('Amount must be a positive number');
      opts.onError?.(err);
      throw err;
    }

    inProgress = true;
    status = 'loading';
    error = null;

    try {
      const token = await manager.wallet.send(mintUrl, amount);
      data = token;
      status = 'success';
      opts.onSuccess?.(token);
      return token;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error = err;
      status = 'error';
      opts.onError?.(err);
      throw err;
    } finally {
      inProgress = false;
      opts.onSettled?.();
    }
  }

  async function prepareSend(
    mintUrl: string,
    amount: number,
    opts: PrepareOptions = {},
  ): Promise<PreparedSendOperation> {
    if (inProgress) {
      const err = new Error('Operation already in progress');
      opts.onError?.(err);
      throw err;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      const err = new Error('Amount must be a positive number');
      opts.onError?.(err);
      throw err;
    }

    inProgress = true;
    status = 'loading';
    error = null;

    try {
      const operation = await manager.send.prepareSend(mintUrl, amount);
      data = operation;
      status = 'success';
      opts.onSuccess?.(operation);
      return operation;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error = err;
      status = 'error';
      opts.onError?.(err);
      throw err;
    } finally {
      inProgress = false;
      opts.onSettled?.();
    }
  }

  async function executePreparedSend(
    operationId: string,
    opts: ExecuteOptions = {},
  ): Promise<{ operation: PendingSendOperation; token: Token }> {
    if (inProgress) {
      const err = new Error('Operation already in progress');
      opts.onError?.(err);
      throw err;
    }

    inProgress = true;
    status = 'loading';
    error = null;

    try {
      const result = await manager.send.executePreparedSend(operationId);
      data = result;
      status = 'success';
      opts.onSuccess?.(result);
      return result;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      error = err;
      status = 'error';
      opts.onError?.(err);
      throw err;
    } finally {
      inProgress = false;
      opts.onSettled?.();
    }
  }

  async function rollback(operationId: string, opts: OperationOptions = {}): Promise<void> {
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
  }

  async function finalize(operationId: string, opts: OperationOptions = {}): Promise<void> {
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
  }

  async function getPendingOperations(): Promise<SendOperation[]> {
    return manager.send.getPendingOperations();
  }

  async function getOperation(operationId: string): Promise<SendOperation | null> {
    return manager.send.getOperation(operationId);
  }

  function reset() {
    status = 'idle';
    error = null;
    data = null;
  }

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
    get status() {
      return status;
    },
    get data() {
      return data;
    },
    get error() {
      return error;
    },
    reset,

    // Convenience booleans
    get isSending() {
      return status === 'loading';
    },
    get isError() {
      return status === 'error';
    },

    /** @deprecated Use `prepareSend()` followed by `executePreparedSend()` instead. */
    send,
  };
}
