import type { Manager } from 'coco-cashu-core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useManager } from '../contexts/ManagerContext';

type ReceiveArg = Parameters<Manager['wallet']['receive']>[0];
type ReceiveStatus = 'idle' | 'loading' | 'success' | 'error';
export type ReceiveOptions = {
  onSuccess?: () => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

const useReceive = () => {
  const manager = useManager();
  const [status, setStatus] = useState<ReceiveStatus>('idle');
  const [error, setError] = useState<Error | null>(null);

  const mountedRef = useRef(true);
  const isReceivingRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const receive = useCallback(
    async (token: ReceiveArg, opts: ReceiveOptions = {}) => {
      if (isReceivingRef.current) {
        const err = new Error('Receive already in progress');
        opts.onError?.(err);
        throw err;
      }
      if (
        typeof token !== 'string' &&
        (!token || !Array.isArray((token as { proofs: unknown[] }).proofs))
      ) {
        const err = new Error('Invalid token');
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        opts.onError?.(err);
        throw err;
      }

      isReceivingRef.current = true;
      if (mountedRef.current) {
        setStatus('loading');
        setError(null);
      }

      try {
        await manager.wallet.receive(token);
        if (mountedRef.current) {
          setStatus('success');
        }
        opts.onSuccess?.();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        if (mountedRef.current) {
          setError(err);
          setStatus('error');
        }
        opts.onError?.(err);
        throw err;
      } finally {
        isReceivingRef.current = false;
        opts.onSettled?.();
      }
    },
    [manager],
  );

  const reset = useCallback(() => {
    if (!mountedRef.current) return;
    setStatus('idle');
    setError(null);
  }, []);

  return {
    receive,
    reset,
    status,
    error,
    isReceiving: status === 'loading',
    isError: status === 'error',
  };
};

export default useReceive;
