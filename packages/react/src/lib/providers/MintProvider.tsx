import { useCallback, useEffect, useState } from 'react';
import { useManager } from '../contexts/ManagerContext';
import { MintCtx, type MintContextValue, type AddMintOptions } from '../contexts/MintContext';

const useMint = (): MintContextValue => {
  const [mints, setMints] = useState<MintContextValue['mints']>([]);
  const [trustedMints, setTrustedMints] = useState<MintContextValue['trustedMints']>([]);
  const manager = useManager();

  const refreshMints = useCallback(async () => {
    try {
      const allMints = await manager.mint.getAllMints();
      setMints(allMints);
      setTrustedMints(allMints.filter((m) => m.trusted));
    } catch (error) {
      console.error(error);
    }
  }, [manager]);

  useEffect(() => {
    refreshMints();
    manager.on('mint:added', refreshMints);
    manager.on('mint:updated', refreshMints);
    return () => {
      manager.off('mint:added', refreshMints);
      manager.off('mint:updated', refreshMints);
    };
  }, [manager, refreshMints]);

  const addNewMint = useCallback(
    async (mintUrl: string, options?: AddMintOptions) => {
      await manager.mint.addMint(mintUrl, options);
    },
    [manager],
  );

  const trustMint = useCallback(
    async (mintUrl: string) => {
      await manager.mint.trustMint(mintUrl);
    },
    [manager],
  );

  const untrustMint = useCallback(
    async (mintUrl: string) => {
      await manager.mint.untrustMint(mintUrl);
    },
    [manager],
  );

  const isTrustedMint = useCallback(
    async (mintUrl: string) => {
      return manager.mint.isTrustedMint(mintUrl);
    },
    [manager],
  );

  return {
    mints,
    trustedMints,
    addNewMint,
    trustMint,
    untrustMint,
    isTrustedMint,
  };
};

export const MintProvider = ({ children }: { children: React.ReactNode }) => (
  <MintCtx.Provider value={useMint()}>{children}</MintCtx.Provider>
);
