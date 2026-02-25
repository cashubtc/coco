import { onDestroy } from 'svelte';
import { getManagerContext } from '../context.js';

export type BalanceValue = {
  [mintUrl: string]: number;
  total: number;
};

/**
 * Reactive balance composable.
 * Returns an object with a reactive `balance` property (Svelte 5 `$state`).
 *
 * Must be called during component initialisation inside a CocoCashuProvider tree.
 */
export function useBalance() {
  const manager = getManagerContext();

  let balance = $state<BalanceValue>({ total: 0 });

  async function refresh() {
    try {
      const bal = await manager.wallet.getBalances();
      const total = Object.values(bal || {}).reduce<number>((acc, cur) => acc + (cur as number), 0);
      balance = { ...(bal || {}), total };
    } catch (error) {
      console.error(error);
    }
  }

  refresh();

  manager.on('proofs:saved', refresh);
  manager.on('proofs:state-changed', refresh);
  manager.on('proofs:deleted', refresh);
  manager.on('proofs:reserved', refresh);
  manager.on('proofs:released', refresh);

  onDestroy(() => {
    manager.off('proofs:saved', refresh);
    manager.off('proofs:state-changed', refresh);
    manager.off('proofs:deleted', refresh);
    manager.off('proofs:reserved', refresh);
    manager.off('proofs:released', refresh);
  });

  return {
    get balance() {
      return balance;
    },
    refresh,
  };
}
