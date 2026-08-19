/** Durable reference to the Mint Swap Operation that owns a Mint or Melt Operation. */
export interface MintSwapOperationParent {
  kind: 'mint-swap';
  id: string;
}
