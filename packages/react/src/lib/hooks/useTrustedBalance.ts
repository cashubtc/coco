import type { BalanceQuery } from '@cashu/coco-core';
import type { WalletBalancesValue } from '../contexts/BalanceContext';
import useBalances from './useBalances';

const TRUSTED_BALANCES_SCOPE: BalanceQuery = { trustedOnly: true };

export type TrustedBalanceValue = WalletBalancesValue;

/**
 * Hook that returns balances only for trusted mints.
 * Returns canonical per-mint snapshots plus an aggregated total.
 */
const useTrustedBalance = () => {
  return useBalances(TRUSTED_BALANCES_SCOPE);
};

export default useTrustedBalance;
