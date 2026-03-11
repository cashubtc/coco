import { useEffect, useState, useCallback } from 'react';
import { useManager } from '../contexts/ManagerContext';
import { useMints } from '../contexts/MintContext';
import type { BalancesBreakdownByMint } from 'coco-cashu-core';

export type TrustedBalanceValue = {
  [mintUrl: string]: number;
  total: number;
};

/**
 * Hook that returns balances only for trusted mints.
 * Returns per-mint balances and a total across all trusted mints.
 */
const useTrustedBalance = () => {
  const [balance, setBalance] = useState<TrustedBalanceValue>({ total: 0 });
  const manager = useManager();
  const { trustedMints } = useMints();

  const refreshBalance = useCallback(async () => {
    try {
      const allBalances: BalancesBreakdownByMint = await manager.wallet.getBalancesBreakdown();
      const trustedMintUrls = new Set(trustedMints.map((m) => m.mintUrl));

      const trustedBalances: TrustedBalanceValue = { total: 0 };

      for (const [mintUrl, breakdown] of Object.entries(allBalances || {})) {
        if (trustedMintUrls.has(mintUrl)) {
          trustedBalances[mintUrl] = breakdown.ready;
          trustedBalances.total += breakdown.ready;
        }
      }

      setBalance(trustedBalances);
    } catch (error) {
      console.error(error);
    }
  }, [manager, trustedMints]);

  useEffect(() => {
    refreshBalance();
    manager.on('proofs:saved', refreshBalance);
    manager.on('proofs:state-changed', refreshBalance);
    manager.on('mint:updated', refreshBalance);
    manager.on('proofs:reserved', refreshBalance);
    manager.on('proofs:released', refreshBalance);
    return () => {
      manager.off('proofs:saved', refreshBalance);
      manager.off('proofs:state-changed', refreshBalance);
      manager.off('mint:updated', refreshBalance);
      manager.off('proofs:reserved', refreshBalance);
      manager.off('proofs:released', refreshBalance);
    };
  }, [manager, refreshBalance]);

  return { balance };
};

export default useTrustedBalance;
