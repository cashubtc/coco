/**
 * Auth BAT integration test — automated via Keycloak password grant.
 *
 * Tests CAT/BAT operations against a live auth-enabled mint.
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
import type { AuthProvider } from '@cashu/cashu-ts';
// poolSize is verified via mgr.auth.getPoolSize() — not via AuthManager cast
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

/**
 * Mint endpoint auth configuration assumed by this suite:
 *
 *   get_mint_quote:    Clear  (CAT)
 *   mint:              Blind  (BAT)
 *   check_mint_quote:  Blind  (BAT)
 *   restore:           Blind  (BAT)
 *   melt / swap / …:   None   (open)
 */
describe('Auth BAT (automated — password grant)', () => {
  let mgr: Manager;
  let repositories: MemoryRepositories;

  beforeAll(async () => {
    const tokens = await acquireTokens();

    repositories = new MemoryRepositories();
    await repositories.init();

    mgr = await initializeCoco({
      repo: repositories,
      seedGetter: async () => new Uint8Array(64),
      watchers: {
        mintQuoteWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
      },
      processors: {
        mintQuoteProcessor: { disabled: true },
      },
    });

    await mgr.mint.addMint(mintUrl, { trusted: true });
    await mgr.auth.login(mintUrl!, tokens);
  });

  it('T1: CAT-protected endpoint succeeds without consuming BATs', async () => {
    const provider = mgr.auth.getAuthProvider(mintUrl) as AuthProvider;
    expect(provider).toBeDefined();
    expect(mgr.auth.getPoolSize(mintUrl)).toBe(0);

    const quote = await mgr.quotes.createMintQuote(mintUrl, 1);
    expect(quote).toBeDefined();
    expect(quote.quote).toBeDefined();

    expect(mgr.auth.getPoolSize(mintUrl)).toBe(0);
  });

  it('T2: ensure() mints BATs via CAT and populates pool', async () => {
    const provider = mgr.auth.getAuthProvider(mintUrl) as AuthProvider;
    expect(provider).toBeDefined();
    expect(mgr.auth.getPoolSize(mintUrl)).toBe(0);

    await provider.ensure!(3);
    expect(mgr.auth.getPoolSize(mintUrl)).toBeGreaterThanOrEqual(3);
  });

  it('T3: session restore → CAT works, BAT re-mintable', async () => {
    const mgr2 = await initializeCoco({
      repo: repositories,
      seedGetter: async () => new Uint8Array(64),
      watchers: {
        mintQuoteWatcher: { disabled: true },
        proofStateWatcher: { disabled: true },
      },
      processors: {
        mintQuoteProcessor: { disabled: true },
      },
    });

    const restored = await mgr2.auth.restore(mintUrl);
    expect(restored).toBe(true);

    const provider2 = mgr2.auth.getAuthProvider(mintUrl) as AuthProvider;
    expect(provider2).toBeDefined();

    const quote = await mgr2.quotes.createMintQuote(mintUrl, 1);
    expect(quote).toBeDefined();
    expect(quote.quote).toBeDefined();

    await provider2.ensure!(2);
    expect(mgr2.auth.getPoolSize(mintUrl)).toBeGreaterThanOrEqual(2);
  });
});
