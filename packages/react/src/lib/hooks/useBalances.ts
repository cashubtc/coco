import {
  Amount,
  type BalanceQuery,
  type BalanceSnapshot,
  type BalancesByMint,
  type BalancesByMintAndUnit,
  type BalancesByUnit,
} from '@cashu/coco-core';
import { useCallback, useEffect, useState } from 'react';
import type { WalletBalancesValue } from '../contexts/BalanceContext';
import { useManager } from '../contexts/ManagerContext';

const EMPTY_BALANCE_SNAPSHOT: BalanceSnapshot = {
  spendable: Amount.zero(),
  reserved: Amount.zero(),
  total: Amount.zero(),
  unit: 'sat',
};

const EMPTY_BALANCES: WalletBalancesValue = {
  byMint: {},
  byMintAndUnit: {},
  byUnit: {},
  total: EMPTY_BALANCE_SNAPSHOT,
  totalByUnit: {},
};

const getBalanceTotal = (byMint: BalancesByMint): BalanceSnapshot => {
  const first = Object.values(byMint)[0];
  const unit = first?.unit ?? 'sat';
  return Object.values(byMint).reduce<BalanceSnapshot>(
    (total, balance) => ({
      spendable: total.spendable.add(balance.spendable),
      reserved: total.reserved.add(balance.reserved),
      total: total.total.add(balance.total),
      unit,
    }),
    { ...EMPTY_BALANCE_SNAPSHOT, unit },
  );
};

const aggregateByUnit = (byMintAndUnit: BalancesByMintAndUnit): BalancesByUnit => {
  const totals: BalancesByUnit = {};
  for (const balancesByUnit of Object.values(byMintAndUnit)) {
    for (const [unit, balance] of Object.entries(balancesByUnit)) {
      const total = totals[unit] ?? {
        spendable: Amount.zero(),
        reserved: Amount.zero(),
        total: Amount.zero(),
        unit,
      };
      total.spendable = total.spendable.add(balance.spendable);
      total.reserved = total.reserved.add(balance.reserved);
      total.total = total.total.add(balance.total);
      totals[unit] = total;
    }
  }
  return totals;
};

const useBalances = (scope?: BalanceQuery) => {
  const [balances, setBalances] = useState<WalletBalancesValue>(EMPTY_BALANCES);
  const manager = useManager();
  const mintUrlsKey = scope?.mintUrls?.join('\0') ?? '';
  const unitsKey = scope?.units?.join('\0') ?? '';
  const hasMintUrlsScope = scope?.mintUrls !== undefined;
  const hasUnitsScope = scope?.units !== undefined;
  const trustedOnly = scope?.trustedOnly;

  const refresh = useCallback(async () => {
    try {
      const balanceScope: BalanceQuery | undefined =
        hasMintUrlsScope || hasUnitsScope || trustedOnly
          ? {
              mintUrls: hasMintUrlsScope ? (mintUrlsKey ? mintUrlsKey.split('\0') : []) : undefined,
              units: hasUnitsScope ? (unitsKey ? unitsKey.split('\0') : []) : undefined,
              trustedOnly,
            }
          : undefined;
      const units = balanceScope?.units;
      const useSingleUnitView = !units || units.length <= 1;
      const byMintAndUnit = await manager.wallet.balances.byMintAndUnit(balanceScope);
      const totalByUnit =
        (await manager.wallet.balances.totalByUnit?.(balanceScope)) ??
        aggregateByUnit(byMintAndUnit);
      const byMint = useSingleUnitView ? await manager.wallet.balances.byMint(balanceScope) : {};
      const total = useSingleUnitView ? getBalanceTotal(byMint) : EMPTY_BALANCE_SNAPSHOT;
      const byUnit =
        (await manager.wallet.balances.byUnit?.(balanceScope)) ?? aggregateByUnit(byMintAndUnit);
      setBalances({ byMint, byMintAndUnit, byUnit, total, totalByUnit });
    } catch (error) {
      console.error(error instanceof Error ? error : new Error(String(error)));
    }
  }, [manager, hasMintUrlsScope, hasUnitsScope, mintUrlsKey, trustedOnly, unitsKey]);

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
