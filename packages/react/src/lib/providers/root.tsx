import { initializeCoco, type CocoConfig, type Manager } from '@cashu/coco-core';
import { useEffect, useRef, useState } from 'react';
import { ManagerProvider } from './Manager';
import { BalanceProvider } from './Balance';
import { MintProvider } from './MintProvider';

type CocoCashuProviderBaseProps = {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  errorFallback?: React.ReactNode | ((error: Error) => React.ReactNode);
};

export type CocoCashuProviderProps = CocoCashuProviderBaseProps &
  (
    | {
        config: CocoConfig;
        manager?: never;
      }
    | {
        manager: Manager;
        config?: never;
      }
  );

const CocoCashuProviderTree = ({
  manager,
  children,
}: {
  manager: Manager;
  children: React.ReactNode;
}) => (
  <ManagerProvider manager={manager}>
    <MintProvider>
      <BalanceProvider>{children}</BalanceProvider>
    </MintProvider>
  </ManagerProvider>
);

const renderErrorFallback = (
  error: Error,
  errorFallback: CocoCashuProviderBaseProps['errorFallback'],
) => (typeof errorFallback === 'function' ? errorFallback(error) : errorFallback);

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const teardownOwnedManager = async (manager: Manager): Promise<void> => {
  // TODO: Replace this bandaid with manager.dispose() once core disposal tears down
  // watchers, processors, and subscriptions.
  try {
    await manager.pauseSubscriptions();
  } finally {
    await manager.dispose();
  }
};

const InitializingCocoCashuProvider = ({
  config,
  children,
  fallback = null,
  errorFallback = null,
}: CocoCashuProviderBaseProps & { config: CocoConfig }) => {
  const initialConfigRef = useRef(config);
  const initializationRef = useRef<Promise<Manager> | null>(null);
  const managerRef = useRef<Manager | null>(null);
  const effectGenerationRef = useRef(0);
  const [manager, setManager] = useState<Manager | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const effectGeneration = effectGenerationRef.current + 1;
    effectGenerationRef.current = effectGeneration;
    let cancelled = false;

    const initialization =
      initializationRef.current ?? initializeCoco(initialConfigRef.current);
    initializationRef.current = initialization;

    initialization
      .then((initializedManager) => {
        if (!cancelled && effectGenerationRef.current === effectGeneration) {
          managerRef.current = initializedManager;
          setManager(initializedManager);
          setError(null);
        }
      })
      .catch((initError: unknown) => {
        if (!cancelled && effectGenerationRef.current === effectGeneration) {
          setManager(null);
          setError(normalizeError(initError));
        }
      });

    return () => {
      cancelled = true;

      void Promise.resolve().then(() => {
        if (effectGenerationRef.current !== effectGeneration) return;

        const initializedManager = managerRef.current;
        managerRef.current = null;

        if (initializedManager) {
          void teardownOwnedManager(initializedManager).catch(() => undefined);
          return;
        }

        void initialization
          .then((lateInitializedManager) => {
            if (effectGenerationRef.current === effectGeneration) {
              void teardownOwnedManager(lateInitializedManager).catch(() => undefined);
            }
          })
          .catch(() => undefined);
      });
    };
  }, []);

  if (error) {
    return <>{renderErrorFallback(error, errorFallback)}</>;
  }

  if (!manager) {
    return <>{fallback}</>;
  }

  return <CocoCashuProviderTree manager={manager}>{children}</CocoCashuProviderTree>;
};

export const CocoCashuProvider = (props: CocoCashuProviderProps) => {
  if (props.manager !== undefined) {
    return (
      <CocoCashuProviderTree manager={props.manager}>{props.children}</CocoCashuProviderTree>
    );
  }

  return (
    <InitializingCocoCashuProvider
      config={props.config}
      fallback={props.fallback}
      errorFallback={props.errorFallback}
    >
      {props.children}
    </InitializingCocoCashuProvider>
  );
};
