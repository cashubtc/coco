import type { CashuMint, Proof } from "@cashu/cashu-ts";

export type MintInfo = Awaited<ReturnType<CashuMint["getInfo"]>>;

export interface CoreProof extends Proof {
  mintUrl: string;
}
