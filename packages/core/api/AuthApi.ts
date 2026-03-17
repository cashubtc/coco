import type { AuthProvider } from '@cashu/cashu-ts';
import type { AuthSession } from '@core/models';
import type { AuthService } from '@core/services';

/**
 * Public API for NUT-21/22 authentication.
 *
 * Thin wrapper that delegates to AuthService,
 * consistent with the other Api → Service pattern.
 */
export class AuthApi {
  constructor(private readonly authService: AuthService) {}

  async startDeviceAuth(mintUrl: string) {
    return this.authService.startDeviceAuth(mintUrl);
  }

  async login(
    mintUrl: string,
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    },
  ): Promise<AuthSession> {
    return this.authService.login(mintUrl, tokens);
  }

  async restore(mintUrl: string): Promise<boolean> {
    return this.authService.restore(mintUrl);
  }

  async logout(mintUrl: string): Promise<void> {
    return this.authService.logout(mintUrl);
  }

  async getSession(mintUrl: string): Promise<AuthSession> {
    return this.authService.getSession(mintUrl);
  }

  async hasSession(mintUrl: string): Promise<boolean> {
    return this.authService.hasSession(mintUrl);
  }

  getAuthProvider(mintUrl: string): AuthProvider | undefined {
    return this.authService.getAuthProvider(mintUrl);
  }

  getPoolSize(mintUrl: string): number {
    return this.authService.getPoolSize(mintUrl);
  }
}
