import type { MintInfo } from '../types';

export interface Mint {
  mintUrl: string;
  name: string;
  mintInfo: MintInfo;
  trusted: boolean;
  createdAt: number;
  updatedAt: number;
  /** Metadata revision. Omitted writes preserve the stored revision; new rows default to zero. */
  metadataRevision?: number;
}
