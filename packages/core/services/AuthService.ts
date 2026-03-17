import {
  AuthManager,
  Mint,
  type AuthProvider,
  type OIDCAuth,
  type TokenResponse,
} from '@cashu/cashu-ts';
import type { MintAdapter } from '@core/infra/MintAdapter';
import type { Logger } from '@core/logging';
import type { AuthSession } from '@core/models';
import type { AuthSessionService } from './AuthSessionService';
import { normalizeMintUrl } from '@core/utils';

/**
 * Core service for NUT-21/22 authentication.
 *
 * Orchestrates cashu-ts AuthManager (CAT/BAT lifecycle) and
 * AuthSessionService (token persistence) so callers only need
 * `mgr.auth.*` to authenticate with mints.
 */
export class AuthService {
  /** Per-mint AuthManager (always present after login/restore). */
  private readonly managers = new Map<string, AuthManager>();
  /** Per-mint PersistingProvider wrapper (returned by getAuthProvider). */
  private readonly providers = new Map<string, AuthProvider>();
  /** Per-mint OIDCAuth (present when refresh_token is available). */
  private readonly oidcClients = new Map<string, OIDCAuth>();

  constructor(
    private readonly authSessionService: AuthSessionService,
    private readonly mintAdapter: MintAdapter,
    private readonly logger?: Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // OIDC Device Code flow
  // ---------------------------------------------------------------------------

  /**
   * Start an OIDC Device Code authorization flow for a mint.
   *
   * Returns the device-code fields (verification_uri, user_code, etc.)
   * plus a `poll()` helper that resolves once the user authorizes.
   * After `poll()` succeeds the session is persisted and the
   * AuthProvider is wired into MintAdapter automatically.
   */
  async startDeviceAuth(mintUrl: string) {
    mintUrl = normalizeMintUrl(mintUrl);

    const auth = new AuthManager(mintUrl);
    const oidc = await this.attachOIDC(mintUrl, auth);

    const device = await oidc.startDeviceAuth();

    return {
      verification_uri: device.verification_uri,
      verification_uri_complete: device.verification_uri_complete,
      user_code: device.user_code,
      /** Poll until the user authorizes; resolves with the OIDC tokens. */
      poll: async (): Promise<TokenResponse> => {
        const tokens = await device.poll();
        await this.saveSessionWithPool(mintUrl, auth, {
          access_token: tokens.access_token!,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
        });
        this.managers.set(mintUrl, auth);
        this.oidcClients.set(mintUrl, oidc);
        const provider = this.createPersistingProvider(mintUrl, auth);
        this.providers.set(mintUrl, provider);
        this.mintAdapter.setAuthProvider(mintUrl, provider);
        this.logger?.info('Auth session established', { mintUrl });
        return tokens;
      },
      /** Cancel the pending device-code poll. */
      cancel: device.cancel,
    };
  }

  // ---------------------------------------------------------------------------
  // Manual login (caller already has tokens, e.g. from auth-code flow)
  // ---------------------------------------------------------------------------

  /**
   * Save OIDC tokens as an auth session and wire the AuthProvider.
   *
   * Use this when the caller already obtained tokens externally
   * (e.g. via Authorization Code + PKCE or password grant).
   */
  async login(
    mintUrl: string,
    tokens: {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    },
  ): Promise<AuthSession> {
    mintUrl = normalizeMintUrl(mintUrl);

    const auth = new AuthManager(mintUrl);
    auth.setCAT(tokens.access_token);

    if (tokens.refresh_token) {
      await this.attachOIDC(mintUrl, auth);
    }

    const session = await this.saveSessionWithPool(mintUrl, auth, tokens);

    this.managers.set(mintUrl, auth);
    const provider = this.createPersistingProvider(mintUrl, auth);
    this.providers.set(mintUrl, provider);
    this.mintAdapter.setAuthProvider(mintUrl, provider);
    this.logger?.info('Auth login completed', { mintUrl });
    return session;
  }

  // ---------------------------------------------------------------------------
  // Restore (app restart)
  // ---------------------------------------------------------------------------

  /**
   * Restore a persisted auth session and wire the AuthProvider.
   *
   * Call this on app startup for each mint that has a stored session.
   * Returns true if a session was found and restored.
   *
   * If the CAT is expired but a refreshToken exists, OIDC is attached
   * so cashu-ts can automatically refresh the CAT on the next request.
   */
  async restore(mintUrl: string): Promise<boolean> {
    mintUrl = normalizeMintUrl(mintUrl);

    const session = await this.authSessionService.getSession(mintUrl);
    if (!session) return false;

    const now = Math.floor(Date.now() / 1000);
    const expired = session.expiresAt <= now;

    if (expired && !session.refreshToken) {
      this.logger?.info('Auth session expired without refresh token, skipping restore', { mintUrl });
      return false;
    }

    const auth = new AuthManager(mintUrl);
    auth.setCAT(session.accessToken);

    if (session.batPool?.length) {
      auth.importPool(session.batPool, 'replace');
    }

    if (session.refreshToken) {
      try {
        await this.attachOIDC(mintUrl, auth);
      } catch (err) {
        this.logger?.warn('Failed to attach OIDC for refresh during restore', {
          mintUrl,
          cause: err instanceof Error ? err.message : String(err),
        });
        if (expired) return false;
      }
    }

    this.managers.set(mintUrl, auth);
    const provider = this.createPersistingProvider(mintUrl, auth);
    this.providers.set(mintUrl, provider);
    this.mintAdapter.setAuthProvider(mintUrl, provider);
    this.logger?.info('Auth session restored', { mintUrl, expired });

    await this.authSessionService.emitUpdated(mintUrl);

    return true;
  }

  // ---------------------------------------------------------------------------
  // Logout
  // ---------------------------------------------------------------------------

  /** Delete the auth session and disconnect the AuthProvider. */
  async logout(mintUrl: string): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    await this.authSessionService.deleteSession(mintUrl);
    this.managers.delete(mintUrl);
    this.providers.delete(mintUrl);
    this.oidcClients.delete(mintUrl);
    this.mintAdapter.clearAuthProvider(mintUrl);
    this.logger?.info('Auth logout completed', { mintUrl });
  }

  // ---------------------------------------------------------------------------
  // Session queries
  // ---------------------------------------------------------------------------

  /** Get a valid (non-expired) session; throws if missing or expired. */
  async getSession(mintUrl: string): Promise<AuthSession> {
    return this.authSessionService.getValidSession(mintUrl);
  }

  /** Check whether a session exists for the given mint. */
  async hasSession(mintUrl: string): Promise<boolean> {
    return this.authSessionService.hasSession(mintUrl);
  }

  // ---------------------------------------------------------------------------
  // AuthProvider access (for advanced use)
  // ---------------------------------------------------------------------------

  /** Get the AuthProvider for a mint, or undefined if not authenticated. */
  getAuthProvider(mintUrl: string): AuthProvider | undefined {
    mintUrl = normalizeMintUrl(mintUrl);
    return this.providers.get(mintUrl);
  }

  /** Get the current BAT pool size for a mint, or 0 if not authenticated. */
  getPoolSize(mintUrl: string): number {
    mintUrl = normalizeMintUrl(mintUrl);
    return this.managers.get(mintUrl)?.poolSize ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Create an OIDCAuth instance from the mint's NUT-21 metadata,
   * attach it to the AuthManager for automatic CAT refresh, and
   * register the onTokens callback for persistence.
   */
  private async attachOIDC(mintUrl: string, auth: AuthManager): Promise<OIDCAuth> {
    const mint = new Mint(mintUrl, { authProvider: auth });
    const oidc = await mint.oidcAuth({
      onTokens: async (t: TokenResponse) => {
        auth.setCAT(t.access_token);
        if (t.access_token) {
          // OAuth refresh may omit refresh_token (RFC 6749 §6) —
          // preserve the existing one so restore() can re-attach OIDC.
          let refreshToken = t.refresh_token;
          if (!refreshToken) {
            const existing = await this.authSessionService.getSession(mintUrl);
            refreshToken = existing?.refreshToken;
          }
          this.saveSessionWithPool(mintUrl, auth, {
            access_token: t.access_token,
            refresh_token: refreshToken,
            expires_in: t.expires_in,
          }).catch((err) => {
            this.logger?.error('Failed to persist session in onTokens', {
              mintUrl,
              cause: err instanceof Error ? err.message : String(err),
            });
          });
        }
      },
    });
    auth.attachOIDC(oidc);
    this.oidcClients.set(mintUrl, oidc);
    return oidc;
  }

  /**
   * Wrap an AuthManager so that every BAT consumption/topUp automatically
   * persists the updated pool to the session store.
   */
  private createPersistingProvider(mintUrl: string, auth: AuthManager): AuthProvider {
    return {
      getBlindAuthToken: async (input) => {
        const token = await auth.getBlindAuthToken(input);
        this.persistPool(mintUrl, auth);
        return token;
      },
      ensure: async (minTokens: number) => {
        await auth.ensure?.(minTokens);
        this.persistPool(mintUrl, auth);
      },
      getCAT: () => auth.getCAT(),
      setCAT: (cat) => auth.setCAT(cat),
      ensureCAT: (minValiditySec) => auth.ensureCAT?.(minValiditySec),
    };
  }

  private persistPool(mintUrl: string, auth: AuthManager): void {
    const pool = auth.exportPool();
    this.authSessionService.updateBatPool(mintUrl, pool.length > 0 ? pool : undefined).catch((err) => {
      this.logger?.error('Failed to persist BAT pool after change', {
        mintUrl,
        cause: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async saveSessionWithPool(
    mintUrl: string,
    auth: AuthManager,
    tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
  ): Promise<AuthSession> {
    const batPool = auth.exportPool();
    return this.authSessionService.saveSession(
      mintUrl,
      tokens,
      batPool.length > 0 ? batPool : undefined,
    );
  }
}
