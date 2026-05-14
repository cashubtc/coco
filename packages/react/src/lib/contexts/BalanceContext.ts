import type {
  BalanceSnapshot,
  BalancesByMint,
  BalancesByMintAndUnit,
  BalancesByUnit,
} from '@cashu/coco-core';
import { createContext, useContext } from 'react';

export type WalletBalancesValue = {
  byMint: BalancesByMint;
  byMintAndUnit: BalancesByMintAndUnit;
  byUnit: BalancesByUnit;
  total: BalanceSnapshot;
  totalByUnit: BalancesByUnit;
};

export type BalanceContextValue = {
  balances: WalletBalancesValue;
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
