import type { Proof } from '@cashu/cashu-ts';

export interface AuthSession {
  mintUrl: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope?: string;
  batPool?: Proof[];
}
