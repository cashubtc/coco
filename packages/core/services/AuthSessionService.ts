import type { CoreEvents, EventBus } from "@core/events";
import { AuthSessionError, AuthSessionExpiredError } from "@core/models";
import type { AuthSessionRepository } from "@core/repositories";
import { normalizeMintUrl } from "@core/utils";
import type { Logger } from "@core/logging";
import type { Proof } from '@cashu/cashu-ts';
import type { AuthSession } from '../models/AuthSession';

export class AuthSessionService {
  private readonly repo: AuthSessionRepository;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    repo: AuthSessionRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.repo = repo;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  /** Get a valid (non-expired) session; throws if missing or expired. */
  async getValidSession(mintUrl: string): Promise<AuthSession> {
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      const session = await this.repo.getSession(mintUrl);
      if (!session) {
        throw new AuthSessionError(mintUrl, 'No auth session found');
      }
      const now = Math.floor(Date.now() / 1000);
      if (session.expiresAt <= now) {
        await this.eventBus.emit('auth-session:expired', { mintUrl });
        throw new AuthSessionExpiredError(mintUrl);
      }
      return session;
    } catch (err) {
      this.logger?.error('Failed to get valid session', { mintUrl, err });
      throw err;
    }
  }

  /** Save OIDC tokens as a session. */
  async saveSession(
    mintUrl: string,
    tokens: { access_token: string; refresh_token?: string; expires_in?: number; scope?: string },
    batPool?: Proof[],
  ): Promise<AuthSession> {
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      const now = Math.floor(Date.now() / 1000);
      const session: AuthSession = {
        mintUrl,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: now + (tokens.expires_in ?? 3600),
        scope: tokens.scope,
        batPool,
      };
      await this.repo.saveSession(session);
      await this.eventBus.emit('auth-session:updated', { mintUrl });
      this.logger?.info('Auth session saved', { mintUrl, expiresAt: session.expiresAt });
      return session;
    } catch (err) {
      this.logger?.error('Failed to save session', { mintUrl, err });
      throw err;
    }
  }

  /** Update only the BAT pool of an existing session (no expiry recalculation, no event). */
  async updateBatPool(mintUrl: string, batPool?: Proof[]): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      const session = await this.repo.getSession(mintUrl);
      if (!session) return;
      session.batPool = batPool;
      await this.repo.saveSession(session);
      this.logger?.debug('BAT pool updated', { mintUrl, poolSize: batPool?.length ?? 0 });
    } catch (err) {
      this.logger?.error('Failed to update BAT pool', { mintUrl, err });
      throw err;
    }
  }

  /** Delete (logout) a session. */
  async deleteSession(mintUrl: string): Promise<void> {
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      await this.repo.deleteSession(mintUrl);
      await this.eventBus.emit('auth-session:deleted', { mintUrl });
      this.logger?.info('Auth session deleted', { mintUrl });
    } catch (err) {
      this.logger?.error('Failed to delete session', { mintUrl, err });
      throw err;
    }
  }

  /** Check whether a valid (non-expired) session exists for the given mint. */
  async hasSession(mintUrl: string): Promise<boolean> {
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      const session = await this.repo.getSession(mintUrl);
      if (!session) return false;
      const now = Math.floor(Date.now() / 1000);
      return session.expiresAt > now;
    } catch (err) {
      this.logger?.error('Failed to check session', { mintUrl, err });
      throw err;
    }
  }
}
