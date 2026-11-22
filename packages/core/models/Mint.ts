import type { MintInfo } from '../types';

export interface Mint {
  mintUrl: string;
  name: string;
  mintInfo: MintInfo;
  trusted: boolean;
  /** Local creation time as whole Unix seconds. */
  createdAt: number;
  /** Local metadata update time as whole Unix seconds; `0` means not yet refreshed. */
  updatedAt: number;
}
