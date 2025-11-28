import { createContext, useContext } from 'react';
import type { Mint } from 'coco-cashu-core';

export type AddMintOptions = {
  trusted?: boolean;
};

export type MintContextValue = {
  /** All mints (trusted and untrusted) */
  mints: Mint[];
  /** Only trusted mints */
  trustedMints: Mint[];
  /** Add a new mint. By default, mints are added as untrusted. */
  addNewMint: (mintUrl: string, options?: AddMintOptions) => Promise<void>;
  /** Mark a mint as trusted */
  trustMint: (mintUrl: string) => Promise<void>;
  /** Mark a mint as untrusted */
  untrustMint: (mintUrl: string) => Promise<void>;
  /** Check if a mint is trusted */
  isTrustedMint: (mintUrl: string) => Promise<boolean>;
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

/**
 * Convenience hook that returns only trusted mints and trust management functions.
 */
export const useTrustedMints = () => {
  const { trustedMints, trustMint, untrustMint, isTrustedMint } = useMints();
  return { mints: trustedMints, trustMint, untrustMint, isTrustedMint };
};
