/**
 * Tier B — Automated auth integration test.
 *
 * Acquires tokens from Keycloak via password grant (no browser needed),
 * then tests the full auth lifecycle via mgr.auth.login().
 *
 * Required env vars:
 *   MINT_URL                    — auth-enabled Nutshell mint
 *   AUTH_TEST_KEYCLOAK_URL      — Keycloak base URL
 *   AUTH_TEST_CLIENT_ID         — OIDC client ID
 *   AUTH_TEST_USERNAME           — test user
 *   AUTH_TEST_PASSWORD           — test user password
 *
 * Run:
 *   ./scripts/auth_mint/test-auth-integration.sh
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager';
import { MemoryRepositories } from '../../repositories/memory';

const mintUrl = process.env.MINT_URL;
const keycloakUrl = process.env.AUTH_TEST_KEYCLOAK_URL;
const clientId = process.env.AUTH_TEST_CLIENT_ID;
const username = process.env.AUTH_TEST_USERNAME;
const password = process.env.AUTH_TEST_PASSWORD;

if (!mintUrl) throw new Error('MINT_URL is not set');
if (!keycloakUrl) throw new Error('AUTH_TEST_KEYCLOAK_URL is not set');
if (!clientId) throw new Error('AUTH_TEST_CLIENT_ID is not set');
if (!username) throw new Error('AUTH_TEST_USERNAME is not set');
if (!password) throw new Error('AUTH_TEST_PASSWORD is not set');

/** Acquire tokens from Keycloak via Resource Owner Password Grant. */
async function acquireTokens(): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const tokenUrl = `${keycloakUrl}/realms/cashu/protocol/openid-connect/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: clientId!,
      username: username!,
      password: password!,
      scope: 'openid offline_access',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak token request failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  }>;
}

describe('Auth Login (automated — password grant)', () => {
  let mgr: Manager;
  let repositories: MemoryRepositories;
  let tokens: { access_token: string; refresh_token?: string; expires_in?: number };

  beforeAll(async () => {
    tokens = await acquireTokens();

    repositories = new MemoryRepositories();
    await repositories.init();

    mgr = await initializeCoco({
      repo: repositories,
      seedGetter: async () => new Uint8Array(32),
      watchers: {
        mintQuoteWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
      },
      processors: {
        mintQuoteProcessor: { disabled: true },
      },
    });
  });

  it('login with tokens and verify session', async () => {
    const session = await mgr.auth.login(mintUrl!, tokens);

    expect(session.accessToken).toBe(tokens.access_token);
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await mgr.auth.hasSession(mintUrl!)).toBe(true);

    const provider = mgr.auth.getAuthProvider(mintUrl!);
    expect(provider).toBeDefined();
    expect(provider!.getCAT()).toBe(tokens.access_token);
  });

  it('restore session after restart', async () => {
    // Create a new Manager with the same repository
    const mgr2 = await initializeCoco({
      repo: repositories,
      seedGetter: async () => new Uint8Array(32),
      watchers: {
        mintQuoteWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
      },
      processors: {
        mintQuoteProcessor: { disabled: true },
      },
    });

    const restored = await mgr2.auth.restore(mintUrl!);
    expect(restored).toBe(true);

    const session = await mgr2.auth.getSession(mintUrl!);
    expect(session.accessToken).toBe(tokens.access_token);

    const provider = mgr2.auth.getAuthProvider(mintUrl!);
    expect(provider).toBeDefined();
  });

  it('logout clears session and provider', async () => {
    await mgr.auth.logout(mintUrl!);

    expect(await mgr.auth.hasSession(mintUrl!)).toBe(false);
    expect(mgr.auth.getAuthProvider(mintUrl!)).toBeUndefined();
  });
});
