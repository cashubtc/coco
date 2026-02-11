import type { Mint } from 'coco-cashu-core';
import { onDestroy } from 'svelte';
import { getManagerContext } from '../context.js';

/**
 * Reactive mints composable using Svelte 5 runes.
 * Returns a reactive object whose `.mints` and `.trustedMints` properties
 * update automatically when the underlying core events fire.
 *
 * Must be called during component initialisation inside a CocoCashuProvider tree.
 */
export function useMints() {
  const manager = getManagerContext();

  let mints = $state<Mint[]>([]);
  let trustedMints = $state<Mint[]>([]);

  async function refresh() {
    try {
      const all = await manager.mint.getAllMints();
      mints = all;
      trustedMints = all.filter((m) => m.trusted);
    } catch (error) {
      console.error('[useMints] refresh error:', error);
    }
  }

  // Initial load
  refresh();

  // Re-fetch whenever core emits relevant events
  const handler = () => {
    refresh();
  };

  manager.on('mint:added', handler);
  manager.on('mint:updated', handler);
  manager.on('mint:trusted', handler);
  manager.on('mint:untrusted', handler);

  onDestroy(() => {
    manager.off('mint:added', handler);
    manager.off('mint:updated', handler);
    manager.off('mint:trusted', handler);
    manager.off('mint:untrusted', handler);
  });

  async function addMint(mintUrl: string, options?: { trusted?: boolean }) {
    await manager.mint.addMint(mintUrl, options);
    // Eagerly refresh so the caller doesn't have to
    await refresh();
  }

  async function trustMint(mintUrl: string) {
    await manager.mint.trustMint(mintUrl);
  }

  async function untrustMint(mintUrl: string) {
    await manager.mint.untrustMint(mintUrl);
  }

  return {
    get mints() {
      return mints;
    },
    get trustedMints() {
      return trustedMints;
    },
    refresh,
    addMint,
    trustMint,
    untrustMint,
  };
}
