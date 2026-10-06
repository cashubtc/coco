import type { AuthProvider, TokenResponse } from '@cashu/cashu-ts';
import type { AuthSession } from '@core/models';

/** Public authentication interface for NUT-21/22, available as `manager.auth`. */
export interface AuthApi {
  /** Start device authorization; polling persists the session and connects the provider. */
  startDeviceAuth(mintUrl: string): Promise<{
    verification_uri: string;
    verification_uri_complete: string | undefined;
    user_code: string;
    poll: () => Promise<TokenResponse>;
    cancel: () => void;
  }>;

  /** Persist externally obtained tokens and connect the mint's authentication provider. */
  login(
    mintUrl: string,
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    },
  ): Promise<AuthSession>;

  /** Restore a persisted session; return false if it cannot be restored. */
  restore(mintUrl: string): Promise<boolean>;

  /** Delete the persisted session and disconnect the mint's authentication provider. */
  logout(mintUrl: string): Promise<void>;

  /** Get a valid session; reject if it is missing or expired. */
  getSession(mintUrl: string): Promise<AuthSession>;

  /** Check whether a valid session exists. */
  hasSession(mintUrl: string): Promise<boolean>;

  /** Get the provider for an authenticated mint. */
  getAuthProvider(mintUrl: string): AuthProvider | undefined;

  /** Get the available blind authentication token count. */
  getPoolSize(mintUrl: string): number;
}
