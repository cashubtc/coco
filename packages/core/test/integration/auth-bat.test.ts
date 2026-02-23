import { describe, it, expect, beforeAll, setDefaultTimeout } from 'bun:test';

setDefaultTimeout(300_000); // 5 min – manual browser authorization needed
import { initializeCoco, type Manager } from '../../Manager';
import { MemoryRepositories } from '../../repositories/memory';

const mintUrl = process.env.MINT_URL;

if (!mintUrl) {
  throw new Error('MINT_URL is not set');
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
describe('Auth Integration (CAT + BAT)', () => {
  let mgr: Manager;
  let repositories: MemoryRepositories;

  beforeAll(async () => {
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

    // Add the mint (GET endpoints don't require auth)
    await mgr.mint.addMint(mintUrl, { trusted: true });

    // Start Device Code Flow
    const device = await mgr.auth.startDeviceAuth(mintUrl);

    console.log('\n========================================');
    console.log('  OIDC Device Code Authorization');
    console.log('========================================');
    console.log(`  Visit: ${device.verification_uri_complete || device.verification_uri}`);
    console.log(`  Code:  ${device.user_code}`);
    console.log('  Waiting for authorization...');
    console.log('========================================\n');

    const tokens = await device.poll();
    expect(tokens.access_token).toBeDefined();
    console.log('Authorization successful - access_token received');
  });

  // ---------------------------------------------------------------------------
  // CAT (Clear Auth Token)
  // ---------------------------------------------------------------------------

  it('T1: CAT-protected endpoint succeeds without consuming BATs', async () => {
    const provider = mgr.auth.getAuthProvider(mintUrl);
    expect(provider).toBeDefined();
    expect(provider!.poolSize).toBe(0);

    // get_mint_quote = Clear → uses CAT header, no BAT needed
    const quote = await mgr.quotes.createMintQuote(mintUrl, 1);
    expect(quote).toBeDefined();
    expect(quote.quote).toBeDefined();

    // Pool stays empty — CAT auth does not touch BATs
    expect(provider!.poolSize).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // BAT (Blind Auth Token) — pool lifecycle
  // ---------------------------------------------------------------------------

  it('T2: ensure() mints BATs via CAT and populates pool', async () => {
    const provider = mgr.auth.getAuthProvider(mintUrl);
    expect(provider).toBeDefined();
    expect(provider!.poolSize).toBe(0);

    // Explicitly mint BATs (uses CAT to call /v1/auth/blind/mint)
    await provider!.ensure!(3);
    expect(provider!.poolSize).toBeGreaterThanOrEqual(3);
  });

  it('T3: session restore → CAT works, BAT re-mintable', async () => {
    // Create a new Manager instance sharing the same repositories
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

    // Restore session from repository
    const restored = await mgr2.auth.restore(mintUrl);
    expect(restored).toBe(true);

    const provider2 = mgr2.auth.getAuthProvider(mintUrl);
    expect(provider2).toBeDefined();

    // CAT works after restore — createMintQuote (Clear-protected)
    const quote = await mgr2.quotes.createMintQuote(mintUrl, 1);
    expect(quote).toBeDefined();
    expect(quote.quote).toBeDefined();

    // BAT re-mintable after restore — ensure() uses restored CAT
    await provider2!.ensure!(2);
    expect(provider2!.poolSize).toBeGreaterThanOrEqual(2);
  });

  // ---------------------------------------------------------------------------
  // checkBlindAuthState / spendBlindAuth (non-standard cdk extension)
  // ---------------------------------------------------------------------------

  it('T4: flush pool, re-issue, checkBlindAuthState all UNSPENT, spend one, verify SPENT', async () => {
    const provider = mgr.auth.getAuthProvider(mintUrl);
    expect(provider).toBeDefined();

    // Flush stale BATs and issue fresh ones
    provider!.importPool([], 'replace');
    expect(provider!.poolSize).toBe(0);

    await provider!.ensure!(3);
    const pool = provider!.exportPool();
    expect(pool.length).toBeGreaterThanOrEqual(3);

    // All fresh BATs should be UNSPENT
    const checkResult = await mgr.auth.checkBlindAuthState(mintUrl, pool);
    expect(checkResult.states).toHaveLength(pool.length);
    for (const s of checkResult.states) {
      expect(s.Y).toBeDefined();
      expect(s.state).toBe('UNSPENT');
    }

    // Pool unchanged after read-only checkstate
    expect(provider!.exportPool().length).toBe(pool.length);

    // Spend one BAT
    const target = pool[0];
    const spendResult = await mgr.auth.spendBlindAuth(mintUrl, target);
    expect(spendResult.state).toBeDefined();
    expect(spendResult.state.state).toBe('SPENT');

    // Verify it's SPENT, others still UNSPENT
    const recheck = await mgr.auth.checkBlindAuthState(mintUrl, pool);
    const targetState = recheck.states[0];
    expect(targetState.state).toBe('SPENT');

    const rest = recheck.states.slice(1);
    for (const s of rest) {
      expect(s.state).toBe('UNSPENT');
    }
  });
});
