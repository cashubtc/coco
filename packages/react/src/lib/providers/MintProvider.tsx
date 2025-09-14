import { useCallback, useEffect, useState } from 'react';
import { useManager } from '../contexts/ManagerContext';
import { MintCtx, type MintContextValue } from '../contexts/MintContext';

const useMint = (): MintContextValue => {
  const [mints, setMints] = useState<MintContextValue['mints']>([]);
  const manager = useManager();

  const getMints = useCallback(async () => {
    try {
      const mints = await manager.mint.getAllMints();
      setMints(mints);
    } catch (error) {
      console.error(error);
    }
  }, [manager]);

  useEffect(() => {
    getMints();
    manager.on('mint:added', getMints);
    manager.on('mint:updated', getMints);
    return () => {
      manager.off('mint:added', getMints);
      manager.off('mint:updated', getMints);
    };
  }, [manager, getMints]);

  const addNewMint = useCallback<MintContextValue['addNewMint']>(
    async (mintUrl: string) => {
      await manager.mint.addMint(mintUrl);
    },
    [manager],
  );

  return { mints, addNewMint };
};

export const MintProvider = ({ children }: { children: React.ReactNode }) => (
  <MintCtx.Provider value={useMint()}>{children}</MintCtx.Provider>
);
