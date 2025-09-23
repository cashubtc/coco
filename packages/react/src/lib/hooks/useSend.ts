import type { Manager } from 'coco-cashu-core';
import { useManager } from '../contexts/ManagerContext';
import { useCallback, useEffect, useRef, useState } from 'react';

type SendResult = Awaited<ReturnType<Manager['wallet']['send']>>;
type SendStatus = 'idle' | 'loading' | 'success' | 'error';
type SendOptions = {
  onSuccess?: (token: SendResult) => void;
  onError?: (error: Error) => void;
  onSettled?: () => void;
};

const useSend = () => {
  const manager = useManager();
  const [status, setStatus] = useState<SendStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<SendResult | null>(null);

  const mountedRef = useRef(true);
  const isSendingRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const send = useCallback(
    async (mintUrl: string, amount: number, opts: SendOptions = {}) => {
      if (isSendingRef.current) {
        const err = new Error('Send already in progress');
        opts.onError?.(err);
        throw err;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        const err = new Error('Amount must be a positive number');
        opts.onError?.(err);
        throw err;
      }

      isSendingRef.current = true;
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
        isSendingRef.current = false;
        opts.onSettled?.();
      }
    },
    [manager],
  );

  const reset = useCallback(() => {
    if (!mountedRef.current) return;
    setStatus('idle');
    setError(null);
    setData(null);
  }, []);

  return {
    send,
    reset,
    status,
    data,
    error,
    isSending: status === 'loading',
    isError: status === 'error',
  };
};

export default useSend;
