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
    deleteSession: mock(async () => {}),
    getValidSession: mock(async () => fakeSession),
    getSession: mock(async () => fakeSession),
    emitUpdated: mock(async () => {}),
    hasSession: mock(async () => true),
  } as unknown as AuthSessionService;

  const mintAdapter = {
    setAuthProvider: mock(() => {}),
    clearAuthProvider: mock(() => {}),
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
    it('persists session and wires AuthProvider into MintAdapter', async () => {
      const session = await service.login(mintUrl, {
        access_token: 'cat-token-abc',
        expires_in: 3600,
      });

      expect(session).toBe(fakeSession);
      expect(authSessionService.saveSession).toHaveBeenCalledTimes(1);
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);

      // AuthProvider should be cached
      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('cat-token-abc');
    });

    it('sets CAT on AuthManager even without refresh_token', async () => {
      await service.login(mintUrl, { access_token: 'no-refresh' });

      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('no-refresh');
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);
    });

    it('calls saveSession with batPool from exportPool', async () => {
      await service.login(mintUrl, { access_token: 'cat-token-abc' });

      // At login time the pool is empty, so batPool should be undefined
      const calls = (authSessionService.saveSession as ReturnType<typeof mock>).mock.calls;
      expect(calls).toHaveLength(1);
      // 3rd arg is batPool — empty pool yields undefined
      expect(calls[0]![2]).toBeUndefined();
    });
  });

  describe('logout', () => {
    it('deletes session and clears AuthProvider', async () => {
      // First login
      await service.login(mintUrl, { access_token: 'cat-token-abc' });
      expect(service.getAuthProvider(mintUrl)).toBeDefined();

      // Then logout
      await service.logout(mintUrl);

      expect(authSessionService.deleteSession).toHaveBeenCalledTimes(1);
      expect(mintAdapter.clearAuthProvider).toHaveBeenCalledTimes(1);
      expect(service.getAuthProvider(mintUrl)).toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('delegates to AuthSessionService.getValidSession', async () => {
      const session = await service.getSession(mintUrl);
      expect(session).toBe(fakeSession);
      expect(authSessionService.getValidSession).toHaveBeenCalledWith(mintUrl);
    });
  });

  describe('hasSession', () => {
    it('delegates to AuthSessionService.hasSession', async () => {
      const result = await service.hasSession(mintUrl);
      expect(result).toBe(true);
      expect(authSessionService.hasSession).toHaveBeenCalledWith(mintUrl);
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

    it('imports batPool into AuthManager when session has batPool', async () => {
      const fakeBatPool = [{ id: 'key1', amount: 1, secret: 's1', C: 'c1' }] as any;
      const sessionWithPool: AuthSession = {
        ...fakeSession,
        batPool: fakeBatPool,
      };
      const mocks = makeMocks();
      (mocks.authSessionService.getSession as ReturnType<typeof mock>).mockImplementation(
        async () => sessionWithPool,
      );
      const testService = new AuthService(mocks.authSessionService, mocks.mintAdapter);

      const result = await testService.restore(mintUrl);
      expect(result).toBe(true);

      const provider = testService.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(typeof provider!.getCAT).toBe('function');
      expect(typeof provider!.ensure).toBe('function');
    });

    it('handles restore gracefully when session has no batPool', async () => {
      const result = await service.restore(mintUrl);
      expect(result).toBe(true);

      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(typeof provider!.getCAT).toBe('function');
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

  describe('getAuthProvider', () => {
    it('returns undefined for unknown mint', () => {
      expect(service.getAuthProvider('https://unknown.test')).toBeUndefined();
    });

    it('returns AuthManager after login', async () => {
      await service.login(mintUrl, { access_token: 'test' });
      const provider = service.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(typeof provider!.getCAT).toBe('function');
      expect(typeof provider!.getBlindAuthToken).toBe('function');
    });
  });

  describe('getPoolSize', () => {
    it('returns 0 for unknown mint', () => {
      expect(service.getPoolSize('https://unknown.test')).toBe(0);
    });

    it('returns 0 after login (pool starts empty)', async () => {
      await service.login(mintUrl, { access_token: 'test' });
      expect(service.getPoolSize(mintUrl)).toBe(0);
    });

    it('returns 0 after logout', async () => {
      await service.login(mintUrl, { access_token: 'test' });
      await service.logout(mintUrl);
      expect(service.getPoolSize(mintUrl)).toBe(0);
    });
  });
});
