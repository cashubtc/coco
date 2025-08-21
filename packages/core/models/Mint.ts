import type { CashuMint } from "@cashu/cashu-ts";

type MintInfo = Awaited<ReturnType<CashuMint["getInfo"]>>;

export interface Mint {
  mintUrl: string;
  name: string;
  mintInfo: MintInfo;
  createdAt: number;
  updatedAt: number;
}
