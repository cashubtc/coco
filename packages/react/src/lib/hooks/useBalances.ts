import type { BalanceQuery, BalanceSnapshot, BalancesByMint } from '@cashu/coco-core';
import { useCallback, useEffect, useState } from 'react';
import type { WalletBalancesValue } from '../contexts/BalanceContext';
import { useManager } from '../contexts/ManagerContext';

const EMPTY_BALANCE_SNAPSHOT: BalanceSnapshot = {
  spendable: 0,
  reserved: 0,
  total: 0,
};

const EMPTY_BALANCES: WalletBalancesValue = {
  byMint: {},
  total: EMPTY_BALANCE_SNAPSHOT,
};

const getBalanceTotal = (byMint: BalancesByMint): BalanceSnapshot => {
  return Object.values(byMint).reduce<BalanceSnapshot>(
    (total, balance) => ({
      spendable: total.spendable + balance.spendable,
      reserved: total.reserved + balance.reserved,
      total: total.total + balance.total,
    }),
    EMPTY_BALANCE_SNAPSHOT,
  );
};

const useBalances = (scope?: BalanceQuery) => {
  const [balances, setBalances] = useState<WalletBalancesValue>(EMPTY_BALANCES);
  const manager = useManager();
  const mintUrlsKey = scope?.mintUrls?.join('\0') ?? '';
  const hasMintUrlsScope = scope?.mintUrls !== undefined;
  const trustedOnly = scope?.trustedOnly;

  const refresh = useCallback(async () => {
    try {
      const balanceScope: BalanceQuery | undefined =
        hasMintUrlsScope || trustedOnly
          ? {
              mintUrls: hasMintUrlsScope ? (mintUrlsKey ? mintUrlsKey.split('\0') : []) : undefined,
              trustedOnly,
            }
          : undefined;
      const byMint = await manager.wallet.balances.byMint(balanceScope);
      const total = getBalanceTotal(byMint);
      setBalances({ byMint, total });
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)));
    }
  }, [manager, hasMintUrlsScope, mintUrlsKey, trustedOnly]);

  useEffect(() => {
    void refresh();
    manager.on('proofs:saved', refresh);
    manager.on('proofs:state-changed', refresh);
    manager.on('mint:updated', refresh);
    manager.on('proofs:reserved', refresh);
    manager.on('proofs:released', refresh);
    return () => {
      manager.off('proofs:saved', refresh);
      manager.off('proofs:state-changed', refresh);
      manager.off('mint:updated', refresh);
      manager.off('proofs:reserved', refresh);
      manager.off('proofs:released', refresh);
    };
  }, [manager, refresh]);

  return { balances, refresh };
};

export default useBalances;
