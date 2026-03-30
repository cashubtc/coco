import type { Manager } from '@cashu/coco-core';
import { ManagerProvider } from './Manager';
import { BalanceProvider } from './Balance';
import { MintProvider } from './MintProvider';

export const CocoCashuProvider = ({
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
