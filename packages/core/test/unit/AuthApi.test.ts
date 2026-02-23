import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { AuthApi } from '../../api/AuthApi.ts';
import type { AuthSessionService } from '../../services/AuthSessionService.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { AuthSession } from '../../models/AuthSession.ts';

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
    hasSession: mock(async () => true),
  } as unknown as AuthSessionService;

  const mintAdapter = {
    setAuthProvider: mock(() => {}),
    clearAuthProvider: mock(() => {}),
    checkBlindAuthState: mock(async () => ({ states: [] })),
    spendBlindAuth: mock(async () => ({ state: { Y: 'y1', state: 'SPENT' } })),
  } as unknown as MintAdapter;

  return { authSessionService, mintAdapter };
}

describe('AuthApi', () => {
  let api: AuthApi;
  let authSessionService: AuthSessionService;
  let mintAdapter: MintAdapter;

  beforeEach(() => {
    const mocks = makeMocks();
    authSessionService = mocks.authSessionService;
    mintAdapter = mocks.mintAdapter;
    api = new AuthApi(authSessionService, mintAdapter);
  });

  describe('login', () => {
    it('persists session and wires AuthProvider into MintAdapter', async () => {
      const session = await api.login(mintUrl, {
        access_token: 'cat-token-abc',
        expires_in: 3600,
      });

      expect(session).toBe(fakeSession);
      expect(authSessionService.saveSession).toHaveBeenCalledTimes(1);
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);

      // AuthProvider should be cached
      const provider = api.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('cat-token-abc');
    });

    it('sets CAT on AuthManager even without refresh_token', async () => {
      await api.login(mintUrl, { access_token: 'no-refresh' });

      const provider = api.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('no-refresh');
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);
    });

    it('calls saveSession with batPool from exportPool', async () => {
      await api.login(mintUrl, { access_token: 'cat-token-abc' });

      // At login time the pool is empty, so batPool should be undefined
      const calls = (authSessionService.saveSession as ReturnType<typeof mock>).mock.calls;
      expect(calls).toHaveLength(1);
      // 3rd arg is batPool — empty pool yields undefined
      expect(calls[0][2]).toBeUndefined();
    });
  });

  describe('logout', () => {
    it('deletes session and clears AuthProvider', async () => {
      // First login
      await api.login(mintUrl, { access_token: 'cat-token-abc' });
      expect(api.getAuthProvider(mintUrl)).toBeDefined();

      // Then logout
      await api.logout(mintUrl);

      expect(authSessionService.deleteSession).toHaveBeenCalledTimes(1);
      expect(mintAdapter.clearAuthProvider).toHaveBeenCalledTimes(1);
      expect(api.getAuthProvider(mintUrl)).toBeUndefined();
    });
  });

  describe('getSession', () => {
    it('delegates to AuthSessionService.getValidSession', async () => {
      const session = await api.getSession(mintUrl);
      expect(session).toBe(fakeSession);
      expect(authSessionService.getValidSession).toHaveBeenCalledWith(mintUrl);
    });
  });

  describe('hasSession', () => {
    it('delegates to AuthSessionService.hasSession', async () => {
      const result = await api.hasSession(mintUrl);
      expect(result).toBe(true);
      expect(authSessionService.hasSession).toHaveBeenCalledWith(mintUrl);
    });
  });

  describe('restore', () => {
    it('returns false when no valid session exists', async () => {
      const mocks = makeMocks();
      (mocks.authSessionService.getValidSession as ReturnType<typeof mock>).mockImplementation(
        async () => {
          throw new Error('No session');
        },
      );
      const testApi = new AuthApi(mocks.authSessionService, mocks.mintAdapter);

      const result = await testApi.restore(mintUrl);
      expect(result).toBe(false);
      expect(mocks.mintAdapter.setAuthProvider).not.toHaveBeenCalled();
    });

    it('restores CAT and wires AuthProvider for valid session', async () => {
      const result = await api.restore(mintUrl);

      expect(result).toBe(true);
      expect(mintAdapter.setAuthProvider).toHaveBeenCalledTimes(1);

      const provider = api.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.getCAT()).toBe('cat-token-abc');
    });

    it('imports batPool into AuthManager when session has batPool', async () => {
      const fakeBatPool = [
        { id: 'key1', amount: 1, secret: 's1', C: 'c1' },
      ] as any;
      const sessionWithPool: AuthSession = {
        ...fakeSession,
        batPool: fakeBatPool,
      };
      const mocks = makeMocks();
      (mocks.authSessionService.getValidSession as ReturnType<typeof mock>).mockImplementation(
        async () => sessionWithPool,
      );
      const testApi = new AuthApi(mocks.authSessionService, mocks.mintAdapter);

      const result = await testApi.restore(mintUrl);
      expect(result).toBe(true);

      const provider = testApi.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.poolSize).toBe(1);
    });

    it('handles restore gracefully when session has no batPool', async () => {
      const result = await api.restore(mintUrl);
      expect(result).toBe(true);

      const provider = api.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(provider!.poolSize).toBe(0);
    });
  });

  describe('getAuthProvider', () => {
    it('returns undefined for unknown mint', () => {
      expect(api.getAuthProvider('https://unknown.test')).toBeUndefined();
    });

    it('returns AuthManager after login', async () => {
      await api.login(mintUrl, { access_token: 'test' });
      const provider = api.getAuthProvider(mintUrl);
      expect(provider).toBeDefined();
      expect(typeof provider!.getCAT).toBe('function');
      expect(typeof provider!.getBlindAuthToken).toBe('function');
    });
  });

  describe('checkBlindAuthState', () => {
    it('converts Proof[] to AuthProof[] and delegates to mintAdapter', async () => {
      const proofs = [
        { id: 'k1', amount: 1, secret: 's1', C: 'C1', dleq: { e: 'e1', s: 's1', r: 'r1' } },
        { id: 'k2', amount: 1, secret: 's2', C: 'C2' },
      ] as any;

      await api.checkBlindAuthState(mintUrl, proofs);

      const calls = (mintAdapter.checkBlindAuthState as ReturnType<typeof mock>).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(normalizedUrl);
      const payload = calls[0][1];
      // dleq should have e, s, r (amount/witness stripped)
      expect(payload).toEqual({
        auth_proofs: [
          { id: 'k1', secret: 's1', C: 'C1', dleq: { e: 'e1', s: 's1', r: 'r1' } },
          { id: 'k2', secret: 's2', C: 'C2' },
        ],
      });
    });

    it('normalizes mintUrl before calling mintAdapter', async () => {
      await api.checkBlindAuthState('https://mint.test/', []);

      const calls = (mintAdapter.checkBlindAuthState as ReturnType<typeof mock>).mock.calls;
      expect(calls[0][0]).toBe(normalizedUrl);
    });
  });

  describe('spendBlindAuth', () => {
    it('converts a single Proof to AuthProof and delegates to mintAdapter', async () => {
      const proof = { id: 'k1', amount: 1, secret: 's1', C: 'C1' } as any;

      const result = await api.spendBlindAuth(mintUrl, proof);

      const calls = (mintAdapter.spendBlindAuth as ReturnType<typeof mock>).mock.calls;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe(normalizedUrl);
      expect(calls[0][1]).toEqual({
        auth_proof: { id: 'k1', secret: 's1', C: 'C1' },
      });
      expect(result).toEqual({ state: { Y: 'y1', state: 'SPENT' } });
    });

    it('propagates errors from mintAdapter', async () => {
      const mocks = makeMocks();
      (mocks.mintAdapter.spendBlindAuth as ReturnType<typeof mock>).mockImplementation(
        async () => { throw new Error('HttpResponseError: 400'); },
      );
      const testApi = new AuthApi(mocks.authSessionService, mocks.mintAdapter);

      await expect(
        testApi.spendBlindAuth(mintUrl, { id: 'k1', amount: 1, secret: 's1', C: 'C1' } as any),
      ).rejects.toThrow('HttpResponseError: 400');
    });
  });
});
