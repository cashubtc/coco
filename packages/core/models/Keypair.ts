export type KeypairPurpose = 'p2pk' | 'nut20_mint_quote';

export type Keypair = {
  publicKeyHex: string;
  secretKey: Uint8Array;
  derivationIndex?: number;
  purpose?: KeypairPurpose;
};
