import type { Manager } from 'coco-cashu-core';
import { useMemo } from 'react';
import { ManagerCtx, useManagerContext } from '../contexts/ManagerContext';

/**
 * Renders children only when manager is initialized.
 * Optionally accepts a fallback (e.g., spinner or null) while initializing,
 * and an errorFallback for error state.
 */
export const ManagerGate = ({
  children,
  fallback = null,
  errorFallback = null,
}: {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  errorFallback?: React.ReactNode;
}) => {
  const { manager, ready, error } = useManagerContext();
  if (error) return <>{errorFallback}</>;
  if (!ready || !manager) return <>{fallback}</>;
  return <>{children}</>;
};

export const ManagerProvider = ({
  manager,
  children,
}: {
  manager: Manager;
  children: React.ReactNode;
}) => {
  const value = useMemo(
    () => ({
      manager,
      ready: true,
      error: null,
      waitUntilReady: () => Promise.resolve(manager),
    }),
    [manager],
  );
  return <ManagerCtx.Provider value={value}>{children}</ManagerCtx.Provider>;
};
