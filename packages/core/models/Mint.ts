import type { MintInfo } from '../types';

export interface Mint {
  mintUrl: string;
  name: string;
  mintInfo: MintInfo;
  trusted: boolean;
  createdAt: number;
  updatedAt: number;
  /** Monotonic metadata revision; absent on snapshots written before revision tracking. */
  metadataRevision?: number;
}
