import type { Manager } from 'coco-cashu-core';
import { getManagerContext } from '../context.js';

type ReceiveArg = Parameters<Manager['wallet']['receive']>[0];
type ReceiveStatus = 'idle' | 'loading' | 'success' | 'error';

export type ReceiveOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

/**
 * Reactive receive composable.
 * Returns `receive()`, `reset()`, and reactive status/error state.
 */
export function useReceive() {
  const manager = getManagerContext();

  let status = $state<ReceiveStatus>('idle');
  let error = $state<Error | null>(null);
  let inProgress = false;

  async function receive(token: ReceiveArg, opts: ReceiveOptions = {}) {
    if (inProgress) {
      const err = new Error('Receive already in progress');
      opts.onError?.(err);
      throw err;
    }
    if (
      typeof token !== 'string' &&
      (!token || !Array.isArray((token as { proofs: unknown[] }).proofs))
    ) {
      const err = new Error('Invalid token');
      error = err;
      status = 'error';
      opts.onError?.(err);
      throw err;
    }

    inProgress = true;
    status = 'loading';
    error = null;

    try {
      await manager.wallet.receive(token);
      status = 'success';
      opts.onSuccess?.();
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

  function reset() {
    status = 'idle';
    error = null;
  }

  return {
    receive,
    reset,
    get status() {
      return status;
    },
    get error() {
      return error;
    },
    get isReceiving() {
      return status === 'loading';
    },
    get isError() {
      return status === 'error';
    },
  };
}
