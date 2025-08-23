import type { MintInfo } from '../types';

export interface Mint {
  mintUrl: string;
  name: string;
  mintInfo: MintInfo;
  createdAt: number;
  updatedAt: number;
}
