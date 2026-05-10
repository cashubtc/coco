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

const InitializingCocoCashuProvider = ({
  config,
  children,
  fallback = null,
  errorFallback = null,
}: CocoCashuProviderBaseProps & { config: CocoConfig }) => {
  const initialConfigRef = useRef(config);
  const initializationRef = useRef<Promise<Manager> | null>(null);
  const [manager, setManager] = useState<Manager | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;

    const initialization =
      initializationRef.current ?? initializeCoco(initialConfigRef.current);
    initializationRef.current = initialization;

    initialization
      .then((initializedManager) => {
        if (!cancelled) {
          setManager(initializedManager);
          setError(null);
        }
      })
      .catch((initError: unknown) => {
        if (!cancelled) {
          setManager(null);
          setError(normalizeError(initError));
        }
      });

    return () => {
      cancelled = true;
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
