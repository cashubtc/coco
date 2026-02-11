import type { Mint } from 'coco-cashu-core';
import { onDestroy } from 'svelte';
import { getManagerContext } from '../context.js';

export type TrustedBalanceValue = {
  [mintUrl: string]: number;
  total: number;
};

/**
 * Reactive balance composable that only includes trusted mints.
 * Returns per-mint balances and a total across all trusted mints.
 */
export function useTrustedBalance() {
  const manager = getManagerContext();

  let balance = $state<TrustedBalanceValue>({ total: 0 });
  let trustedMintUrls: string[] = [];

  async function refreshMints() {
    try {
      const all = await manager.mint.getAllMints();
      trustedMintUrls = all.filter((m: Mint) => m.trusted).map((m: Mint) => m.mintUrl);
    } catch (error) {
      console.error(error);
    }
  }

  async function refreshBalance() {
    try {
      const allBalances = await manager.wallet.getBalances();
      const trustedBalances: TrustedBalanceValue = { total: 0 };

      for (const [mintUrl, amount] of Object.entries(allBalances || {})) {
        if (trustedMintUrls.includes(mintUrl)) {
          trustedBalances[mintUrl] = amount as number;
          trustedBalances.total += amount as number;
        }
      }

      balance = trustedBalances;
    } catch (error) {
      console.error(error);
    }
  }

  async function refresh() {
    await refreshMints();
    await refreshBalance();
  }

  refresh();

  manager.on('proofs:saved', refresh);
  manager.on('proofs:state-changed', refresh);
  manager.on('mint:updated', refresh);

  onDestroy(() => {
    manager.off('proofs:saved', refresh);
    manager.off('proofs:state-changed', refresh);
    manager.off('mint:updated', refresh);
  });

  return {
    get balance() {
      return balance;
    },
    refresh,
  };
}
