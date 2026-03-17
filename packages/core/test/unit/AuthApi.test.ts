import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { AuthApi } from '../../api/AuthApi.ts';
import type { AuthService } from '../../services/AuthService.ts';

const mintUrl = 'https://mint.test';

const fakeSession = { mintUrl, accessToken: 'cat', expiresAt: 9999999999 } as any;
const fakeDeviceAuth = {
  verification_uri: 'https://auth.test/device',
  verification_uri_complete: undefined,
  user_code: 'ABCD',
  poll: mock(async () => ({})),
  cancel: mock(() => {}),
};

function makeAuthService() {
  return {
    startDeviceAuth: mock(async () => fakeDeviceAuth),
    login: mock(async () => fakeSession),
    restore: mock(async () => true),
    logout: mock(async () => {}),
    getSession: mock(async () => fakeSession),
    hasSession: mock(async () => true),
    getAuthProvider: mock(() => undefined),
    getPoolSize: mock(() => 5),
  } as unknown as AuthService;
}

describe('AuthApi', () => {
  let api: AuthApi;
  let authService: AuthService;

  beforeEach(() => {
    authService = makeAuthService();
    api = new AuthApi(authService);
  });

  it('delegates startDeviceAuth to AuthService', async () => {
    const result = await api.startDeviceAuth(mintUrl);
    expect(result).toBe(fakeDeviceAuth);
    expect(authService.startDeviceAuth).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates login to AuthService', async () => {
    const tokens = { access_token: 'cat-abc', expires_in: 3600 };
    const result = await api.login(mintUrl, tokens);
    expect(result).toBe(fakeSession);
    expect(authService.login).toHaveBeenCalledWith(mintUrl, tokens);
  });

  it('delegates restore to AuthService', async () => {
    const result = await api.restore(mintUrl);
    expect(result).toBe(true);
    expect(authService.restore).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates logout to AuthService', async () => {
    await api.logout(mintUrl);
    expect(authService.logout).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates getSession to AuthService', async () => {
    const result = await api.getSession(mintUrl);
    expect(result).toBe(fakeSession);
    expect(authService.getSession).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates hasSession to AuthService', async () => {
    const result = await api.hasSession(mintUrl);
    expect(result).toBe(true);
    expect(authService.hasSession).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates getAuthProvider to AuthService', () => {
    api.getAuthProvider(mintUrl);
    expect(authService.getAuthProvider).toHaveBeenCalledWith(mintUrl);
  });

  it('delegates getPoolSize to AuthService', () => {
    const result = api.getPoolSize(mintUrl);
    expect(result).toBe(5);
    expect(authService.getPoolSize).toHaveBeenCalledWith(mintUrl);
  });
});
