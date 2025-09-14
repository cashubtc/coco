import { useEffect, useState } from 'react';
import { useManager } from '../contexts/ManagerContext';
import { BalanceCtx, type BalanceContextValue } from '../contexts/BalanceContext';

const useBalance = (): BalanceContextValue => {
  const [balance, setBalance] = useState<BalanceContextValue['balance']>({ total: 0 });
  const manager = useManager();

  useEffect(() => {
    async function getBalance() {
      try {
        const bal = await manager.wallet.getBalances();
        const total = Object.values(bal || {}).reduce((acc, cur) => acc + cur, 0);
        setBalance({ ...(bal || {}), total });
      } catch (error) {
        console.error(error);
      }
    }
    getBalance();
    manager.on('proofs:saved', getBalance);
    manager.on('proofs:state-changed', getBalance);
    return () => {
      manager.off('proofs:saved', getBalance);
      manager.off('proofs:state-changed', getBalance);
    };
  }, [manager]);

  return { balance };
};

export const BalanceProvider = ({ children }: { children: React.ReactNode }) => (
  <BalanceCtx.Provider value={useBalance()}>{children}</BalanceCtx.Provider>
);
