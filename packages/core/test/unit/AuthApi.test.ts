import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AuthSessionError, Manager, MemoryRepositories, type AuthApi } from '../../index.ts';

const mintUrl = 'https://mint.test';

// Public consumers can supply an implementation structurally. Only these eight methods are visible.
type AuthMethod =
  | 'startDeviceAuth'
  | 'login'
  | 'restore'
  | 'logout'
  | 'getSession'
  | 'hasSession'
  | 'getAuthProvider'
  | 'getPoolSize';
const publicMethodsMatch: [keyof AuthApi] extends [AuthMethod]
  ? [AuthMethod] extends [keyof AuthApi]
    ? true
    : false
  : false = true;

function assertPublicTypes(auth: AuthApi): void {
  // @ts-expect-error Persistence dependencies are not part of the public authentication interface.
  auth.authSessionService;
  // @ts-expect-error Internal persistence helpers are not part of the public interface.
  auth.saveSessionWithPool;
}

describe('manager.auth', () => {
  let repositories: MemoryRepositories;
  let manager: Manager;
  const managers: Manager[] = [];

  beforeEach(() => {
    repositories = new MemoryRepositories();
    manager = new Manager(repositories, async () => new Uint8Array(64));
    managers.push(manager);
  });

  afterEach(async () => {
    for (const session of managers.splice(0)) await session.dispose();
  });

  it('preserves login, session queries, provider access, logout, and auth events', async () => {
    expect(publicMethodsMatch).toBe(true);
    const events: string[] = [];
    manager.on('auth-session:updated', ({ mintUrl }) => {
      events.push(`updated:${mintUrl}`);
    });
    manager.on('auth-session:deleted', ({ mintUrl }) => {
      events.push(`deleted:${mintUrl}`);
    });

    const auth: AuthApi = manager.auth;
    const session = await auth.login(`${mintUrl}/`, {
      access_token: 'cat-token',
      expires_in: 3600,
      scope: 'cashu',
    });

    expect(session.mintUrl).toBe(mintUrl);
    expect(session.scope).toBe('cashu');
    expect(await auth.getSession(mintUrl)).toEqual(session);
    expect(await auth.hasSession(mintUrl)).toBe(true);
    expect(auth.getAuthProvider(mintUrl)?.getCAT()).toBe('cat-token');
    expect(auth.getPoolSize(mintUrl)).toBe(0);
    expect(await repositories.authSessionRepository.getSession(mintUrl)).toEqual(session);

    await auth.logout(`${mintUrl}/`);

    expect(await auth.hasSession(mintUrl)).toBe(false);
    expect(auth.getAuthProvider(mintUrl)).toBeUndefined();
    expect(auth.getPoolSize(mintUrl)).toBe(0);
    expect(await repositories.authSessionRepository.getSession(mintUrl)).toBeNull();
    await expect(auth.getSession(mintUrl)).rejects.toBeInstanceOf(AuthSessionError);
    expect(events).toEqual([`updated:${mintUrl}`, `deleted:${mintUrl}`]);
  });

  it('restores a persisted session in a new Coco Session', async () => {
    await manager.auth.login(mintUrl, { access_token: 'persisted-cat', expires_in: 3600 });
    const nextManager = new Manager(repositories, async () => new Uint8Array(64));
    managers.push(nextManager);

    expect(nextManager.auth.getAuthProvider(mintUrl)).toBeUndefined();
    expect(await nextManager.auth.restore(`${mintUrl}/`)).toBe(true);
    expect(nextManager.auth.getAuthProvider(mintUrl)?.getCAT()).toBe('persisted-cat');
    expect((await nextManager.auth.getSession(mintUrl)).accessToken).toBe('persisted-cat');
  });

  it('keeps missing-session restore and query behavior', async () => {
    expect(await manager.auth.restore(mintUrl)).toBe(false);
    expect(await manager.auth.hasSession(mintUrl)).toBe(false);
    expect(manager.auth.getAuthProvider(mintUrl)).toBeUndefined();
    await expect(manager.auth.getSession(mintUrl)).rejects.toBeInstanceOf(AuthSessionError);
  });
});
