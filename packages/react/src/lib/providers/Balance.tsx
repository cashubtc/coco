import useBalances from '../hooks/useBalances';
import { BalanceCtx, type BalanceContextValue } from '../contexts/BalanceContext';

const useBalance = (): BalanceContextValue => {
  const { balances } = useBalances();
  return { balances };
};

export const BalanceProvider = ({ children }: { children: React.ReactNode }) => (
  <BalanceCtx.Provider value={useBalance()}>{children}</BalanceCtx.Provider>
);
