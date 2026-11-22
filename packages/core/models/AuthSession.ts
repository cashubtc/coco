import type { Proof } from '@cashu/cashu-ts';

export interface AuthSession {
  mintUrl: string;
  accessToken: string;
  refreshToken?: string;
  /** Token expiry as Unix seconds; fractional precision is preserved and `0` is already expired. */
  expiresAt: number;
  scope?: string;
  batPool?: Proof[];
}
