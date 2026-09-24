import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { AuthService } from '../../services/AuthService.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { AuthSession } from '../../models/AuthSession.ts';
import type { AuthSessionService } from '../../services/AuthSessionService.ts';

const mintUrl = 'https://mint.test';
const normalizedUrl = 'https://mint.test';

const fakeSession: AuthSession = {
  mintUrl: normalizedUrl,
  accessToken: 'cat-token-abc',
  refreshToken: 'refresh-xyz',
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  scope: undefined,
};

const expiredSession: AuthSession = {
  mintUrl: normalizedUrl,
  accessToken: 'expired-cat',
  expiresAt: Math.floor(Date.now() / 1000) - 100,
};

function makeMocks() {
  const authSessionService = {
    saveSession: mock(async () => fakeSession),
    getSession: mock(async () => fakeSession),
    emitUpdated: mock(async () => {}),
  } as unknown as AuthSessionService;

  const mintAdapter = {
    setAuthProvider: mock(() => {}),
  } as unknown as MintAdapter;

  return { authSessionService, mintAdapter };
}

describe('AuthService', () => {
  let service: AuthService;
  let authSessionService: AuthSessionService;
  let mintAdapter: MintAdapter;

  beforeEach(() => {
    const mocks = makeMocks();
    authSessionService = mocks.authSessionService;
    mintAdapter = mocks.mintAdapter;
    service = new AuthService(authSessionService, mintAdapter);
  });

  describe('login', () => {
    it('sets CAT on AuthManager even without refresh_token', async () => {
      await service.login(mintUrl, { access_token: 'no-refresh' });

      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('no-refresh');
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe('restore', () => {
    it('returns false when no session exists', async () => {
      const mocks = makeMocks();
      (mocks.authSessionService.getSession as ReturnType<typeof mock>).mockImplementation(
        async () => null,
      );
      const testService = new AuthService(mocks.authSessionService, mocks.mintAdapter);

      const result = await testService.restore(mintUrl);
      expect(result).toBe(false);
      expect(mocks.mintAdapter.setAuthProvider).not.toHaveBeenCalled();
    });

    it('restores CAT and wires AuthProvider for valid session', async () => {
      const result = await service.restore(mintUrl);

      expect(result).toBe(true);
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);

      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('cat-token-abc');
    });

    it('returns false when session is expired without refreshToken', async () => {
      const mocks = makeMocks();
      (mocks.authSessionService.getSession as ReturnType<typeof mock>).mockImplementation(
        async () => expiredSession,
      );
      const testService = new AuthService(mocks.authSessionService, mocks.mintAdapter);

      const result = await testService.restore(mintUrl);
      expect(result).toBe(false);
      expect(mocks.mintAdapter.setAuthProvider).not.toHaveBeenCalled();
    });

    it('attempts restore for expired session with refreshToken (falls back on OIDC failure)', async () => {
      const expiredWithRefresh: AuthSession = {
        ...expiredSession,
        refreshToken: 'refresh-xyz',
      };
      const mocks = makeMocks();
      (mocks.authSessionService.getSession as ReturnType<typeof mock>).mockImplementation(
        async () => expiredWithRefresh,
      );
      const testService = new AuthService(mocks.authSessionService, mocks.mintAdapter);

      // In unit tests, attachOIDC fails (no real mint) → expired + OIDC failure = false
      // In production with a real mint, attachOIDC succeeds and restore returns true
      const result = await testService.restore(mintUrl);
      expect(result).toBe(false);
    });
  });

  describe('getPoolSize', () => {
    it('returns 0 for unknown mint', () => {
      expect(service.getPoolSize('https://unknown.test')).toBe(0);
    });
  });
});
