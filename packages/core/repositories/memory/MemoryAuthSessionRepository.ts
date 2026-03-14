import type { AuthSession } from '@core/models/AuthSession';
import type { AuthSessionRepository } from '..';

export class MemoryAuthSessionRepository implements AuthSessionRepository {
  private readonly sessions = new Map<string, AuthSession>();

  async getSession(mintUrl: string): Promise<AuthSession | null> {
    return this.sessions.get(mintUrl) ?? null;
  }

  async saveSession(session: AuthSession): Promise<void> {
    this.sessions.set(session.mintUrl, session);
  }

  async deleteSession(mintUrl: string): Promise<void> {
    this.sessions.delete(mintUrl);
  }

  async getAllSessions(): Promise<AuthSession[]> {
    return [...this.sessions.values()];
  }
}
