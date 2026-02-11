import type { Manager } from 'coco-cashu-core';
import { getContext, setContext } from 'svelte';

const MANAGER_KEY = Symbol('coco-cashu-manager');

/**
 * Sets the Manager instance in Svelte context.
 * Called internally by CocoCashuProvider / ManagerProvider.
 */
export function setManagerContext(manager: Manager): void {
  setContext(MANAGER_KEY, manager);
}

/**
 * Retrieves the Manager instance from Svelte context.
 * Must be called during component initialisation inside a CocoCashuProvider tree.
 *
 * @throws If no Manager has been provided via context.
 */
export function getManagerContext(): Manager {
  const manager = getContext<Manager | undefined>(MANAGER_KEY);
  if (!manager) {
    throw new Error(
      'Manager not found in context. ' +
        'Wrap your component tree with <CocoCashuProvider> or <ManagerProvider>.',
    );
  }
  return manager;
}
