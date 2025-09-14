import type { Manager } from 'coco-cashu-core';
import { createContext, useContext } from 'react';

export type ManagerContextValue = {
  manager: Manager | null;
  ready: boolean;
  error: Error | null;
  waitUntilReady: () => Promise<Manager>;
};

export const ManagerCtx = createContext<ManagerContextValue>({
  manager: null,
  ready: false,
  error: null,
  waitUntilReady: () => Promise.reject(new Error('Manager not initialized')),
});

export const useManagerContext = (): ManagerContextValue => {
  const ctx = useContext(ManagerCtx);
  if (!ctx) {
    throw new Error(
      'ManagerProvider is missing. Wrap your app in <CocoCashuProvider> or <ManagerProvider>.',
    );
  }
  return ctx;
};

export const useManager = (): Manager => {
  const { manager } = useManagerContext();
  if (!manager) {
    throw new Error(
      'Manager is not ready. Wrap the component tree with <ManagerGate> or check readiness via useManagerContext().',
    );
  }
  return manager;
};
