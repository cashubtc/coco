import {
  AuthManager,
  Mint,
  type OIDCAuth,
  type AuthProvider,
  type TokenResponse,
} from '@cashu/cashu-ts';
import type { Proof } from '@cashu/cashu-ts';
import type { AuthSessionService } from '@core/services';
import type { AuthSession } from '@core/models';
import type { MintAdapter } from '@core/infra/MintAdapter';
import type { Logger } from '@core/logging';
import { normalizeMintUrl } from '@core/utils';
import { toAuthProof } from '@core/types';

/**
 * Public API for NUT-21/22 authentication.
 *
 * Orchestrates cashu-ts AuthManager (CAT/BAT lifecycle) and
 * AuthSessionService (token persistence) so callers only need
 * `mgr.auth.*` to authenticate with mints.
 */
export class AuthApi {
  /** Per-mint AuthManager (always present after login/restore). */
  private readonly managers = new Map<string, AuthManager>();
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
    const mint = new Mint(mintUrl, { authProvider: auth });
    const oidc = await mint.oidcAuth({
      onTokens: (t: TokenResponse) => {
        auth.setCAT(t.access_token);
        if (t.access_token) {
          this.saveSessionWithPool(mintUrl, auth, {
            access_token: t.access_token,
            refresh_token: t.refresh_token,
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
        this.mintAdapter.setAuthProvider(mintUrl, this.createPersistingProvider(mintUrl, auth));
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
    this.mintAdapter.setAuthProvider(mintUrl, this.createPersistingProvider(mintUrl, auth));
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
   * Returns true if a valid session was found and restored.
   */
  async restore(mintUrl: string): Promise<boolean> {
    mintUrl = normalizeMintUrl(mintUrl);

    let session: AuthSession;
    try {
      session = await this.authSessionService.getValidSession(mintUrl);
    } catch {
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
      }
    }

    this.managers.set(mintUrl, auth);
    this.mintAdapter.setAuthProvider(mintUrl, this.createPersistingProvider(mintUrl, auth));
    this.logger?.info('Auth session restored', { mintUrl });
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
    return this.managers.get(mintUrl);
  }

  // ---------------------------------------------------------------------------
  // BAT state queries (non-standard cdk extension)
  // ---------------------------------------------------------------------------

  /**
   * Check whether BATs are valid and unspent without consuming them.
   * Calls the mint's POST /v1/auth/blind/checkstate endpoint.
   */
  async checkBlindAuthState(mintUrl: string, proofs: Proof[]) {
    mintUrl = normalizeMintUrl(mintUrl);
    return this.mintAdapter.checkBlindAuthState(mintUrl, {
      auth_proofs: proofs.map(toAuthProof),
    });
  }

  /**
   * Mark a single BAT as spent on the mint.
   * Calls the mint's POST /v1/auth/blind/spend endpoint.
   * Does not modify the local BAT pool — caller is responsible for pool management.
   */
  async spendBlindAuth(mintUrl: string, proof: Proof) {
    mintUrl = normalizeMintUrl(mintUrl);
    return this.mintAdapter.spendBlindAuth(mintUrl, {
      auth_proof: toAuthProof(proof),
    });
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Create an OIDCAuth instance from the mint's NUT-21 metadata,
   * attach it to the AuthManager for automatic CAT refresh, and
   * register the onTokens callback for persistence.
   */
  private async attachOIDC(mintUrl: string, auth: AuthManager): Promise<void> {
    const mint = new Mint(mintUrl, { authProvider: auth });
    const oidc = await mint.oidcAuth({
      onTokens: (t: TokenResponse) => {
        auth.setCAT(t.access_token);
        if (t.access_token) {
          this.saveSessionWithPool(mintUrl, auth, {
            access_token: t.access_token,
            refresh_token: t.refresh_token,
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
