import { createContext, useContext } from 'react';

export type BalanceContextValue = {
  balance: {
    [mintUrl: string]: number;
    total: number;
  };
};

export const BalanceCtx = createContext<BalanceContextValue | undefined>(undefined);

export const useBalanceContext = (): BalanceContextValue => {
  const ctx = useContext(BalanceCtx);
  if (!ctx) {
    throw new Error(
      'BalanceProvider is missing. Wrap your app in <CocoCashuProvider> or <BalanceProvider>.',
    );
  }
  return ctx;
};
