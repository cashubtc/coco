import type { AuthSessionRepository, AuthSession } from 'coco-cashu-core';
import { SqliteDb } from '../db.ts';

interface AuthSessionRow {
  mintUrl: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
  batPoolJson: string | null;
}

function rowToSession(row: AuthSessionRow): AuthSession {
  return {
    mintUrl: row.mintUrl,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken ?? undefined,
    expiresAt: row.expiresAt,
    scope: row.scope ?? undefined,
    batPool: row.batPoolJson ? JSON.parse(row.batPoolJson) : undefined,
  };
}

export class SqliteAuthSessionRepository implements AuthSessionRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async getSession(mintUrl: string): Promise<AuthSession | null> {
    const row = await this.db.get<AuthSessionRow>(
      'SELECT mintUrl, accessToken, refreshToken, expiresAt, scope, batPoolJson FROM coco_cashu_auth_sessions WHERE mintUrl = ? LIMIT 1',
      [mintUrl],
    );
    if (!row) return null;
    return rowToSession(row);
  }

  async saveSession(session: AuthSession): Promise<void> {
    await this.db.run(
      `INSERT INTO coco_cashu_auth_sessions (mintUrl, accessToken, refreshToken, expiresAt, scope, batPoolJson)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(mintUrl) DO UPDATE SET
         accessToken=excluded.accessToken,
         refreshToken=excluded.refreshToken,
         expiresAt=excluded.expiresAt,
         scope=excluded.scope,
         batPoolJson=excluded.batPoolJson`,
      [
        session.mintUrl,
        session.accessToken,
        session.refreshToken ?? null,
        session.expiresAt,
        session.scope ?? null,
        session.batPool ? JSON.stringify(session.batPool) : null,
      ],
    );
  }

  async deleteSession(mintUrl: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_auth_sessions WHERE mintUrl = ?', [mintUrl]);
  }

  async getAllSessions(): Promise<AuthSession[]> {
    const rows = await this.db.all<AuthSessionRow>(
      'SELECT mintUrl, accessToken, refreshToken, expiresAt, scope, batPoolJson FROM coco_cashu_auth_sessions',
    );
    return rows.map(rowToSession);
  }
}
