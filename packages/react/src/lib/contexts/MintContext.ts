import { createContext, useContext } from 'react';
import type { Mint } from 'coco-cashu-core';

export type MintContextValue = {
  mints: Mint[];
  addNewMint: (mintUrl: string) => Promise<void>;
};

export const MintCtx = createContext<MintContextValue | undefined>(undefined);

export const useMints = (): MintContextValue => {
  const ctx = useContext(MintCtx);
  if (!ctx) {
    throw new Error(
      'MintProvider is missing. Wrap your app in <CocoCashuProvider> or <MintProvider>.',
    );
  }
  return ctx;
};
