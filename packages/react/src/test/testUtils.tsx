import type { Manager } from '@cashu/coco-core';
import { StrictMode } from 'react';
import type { ReactNode } from 'react';
import { ManagerProvider } from '../lib/providers/Manager.tsx';

export function createHookWrapper(manager: Manager) {
  return function HookWrapper({ children }: { children: ReactNode }) {
    return <ManagerProvider manager={manager}>{children}</ManagerProvider>;
  };
}

export function createStrictHookWrapper(manager: Manager) {
  return function StrictHookWrapper({ children }: { children: ReactNode }) {
    return (
      <StrictMode>
        <ManagerProvider manager={manager}>{children}</ManagerProvider>
      </StrictMode>
    );
  };
}

export function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}
