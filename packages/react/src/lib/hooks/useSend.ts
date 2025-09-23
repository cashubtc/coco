import type { Manager } from 'coco-cashu-core';
import { useManager } from '../contexts/ManagerContext';
import { useState } from 'react';

type SendResult = Awaited<ReturnType<Manager['wallet']['send']>>;
type SendOptions = {
  onSuccess?: (token: SendResult) => void;
  onError?: (error: Error) => void;
};

const useSend = () => {
  const manager = useManager();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const send = async (mintUrl: string, amount: number, opts: SendOptions = {}) => {
    setIsLoading(true);
    setError(null);
    try {
      const token = await manager.wallet.send(mintUrl, amount);
      opts.onSuccess?.(token);
      return token;
    } catch (error) {
      setError(error as Error);
      opts.onError?.(error as Error);
    } finally {
      setIsLoading(false);
    }
  };

  return { send, isLoading, error, isError: !!error };
};

export default useSend;
