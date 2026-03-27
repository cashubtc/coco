import type { AuthSessionRepository, AuthSession } from 'coco-cashu-core';
import type { IdbDb, AuthSessionRow } from '../lib/db.ts';

export class IdbAuthSessionRepository implements AuthSessionRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async getSession(mintUrl: string): Promise<AuthSession | null> {
    const row = (await (this.db as any).table('coco_cashu_auth_sessions').get(mintUrl)) as
      | AuthSessionRow
      | undefined;
    if (!row) return null;
    return {
      mintUrl: row.mintUrl,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken ?? undefined,
      expiresAt: row.expiresAt,
      scope: row.scope ?? undefined,
      batPool: row.batPoolJson ? JSON.parse(row.batPoolJson) : undefined,
    };
  }

  async saveSession(session: AuthSession): Promise<void> {
    const row: AuthSessionRow = {
      mintUrl: session.mintUrl,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken ?? null,
      expiresAt: session.expiresAt,
      scope: session.scope ?? null,
      batPoolJson: session.batPool ? JSON.stringify(session.batPool) : null,
    };
    await (this.db as any).table('coco_cashu_auth_sessions').put(row);
  }

  async deleteSession(mintUrl: string): Promise<void> {
    await (this.db as any).table('coco_cashu_auth_sessions').delete(mintUrl);
  }

  async getAllSessions(): Promise<AuthSession[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_auth_sessions')
      .toArray()) as AuthSessionRow[];
    return rows.map((row) => ({
      mintUrl: row.mintUrl,
      accessToken: row.accessToken,
      refreshToken: row.refreshToken ?? undefined,
      expiresAt: row.expiresAt,
      scope: row.scope ?? undefined,
      batPool: row.batPoolJson ? JSON.parse(row.batPoolJson) : undefined,
    }));
  }
}
