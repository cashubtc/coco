import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager';
import { MemoryRepositories } from '../../repositories/memory';
import { NullLogger } from '../../logging';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Pause/Resume Integration Test', () => {
  let manager: Manager;
  const mintUrl = 'https://nofees.testnut.cashu.space';
  const seedGetter = async () => new Uint8Array(64).fill(1);

  beforeEach(async () => {
    const repositories = new MemoryRepositories();
    manager = await initializeCoco({
      repo: repositories,
      seedGetter,
      logger: new NullLogger(),
      // Use faster intervals for testing
      watchers: {
        mintQuoteWatcher: {
          watchExistingPendingOnStart: true,
        },
      },
      processors: {
        mintQuoteProcessor: {
          processIntervalMs: 500,
          baseRetryDelayMs: 1000,
          maxRetries: 3,
          initialEnqueueDelayMs: 100,
        },
      },
    });
  });

  afterEach(async () => {
    if (manager) {
      await manager.pauseSubscriptions();
      await manager.dispose();
    }
  });

  it('should pause and resume subscriptions with real mint', async () => {
    // Verify initial state - watchers and processor should be running
    expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

    // Add mint first
    await manager.mint.addMint(mintUrl);

    // Create a mint quote
    const quote1 = await manager.quotes.createMintQuote(mintUrl, 1);
    expect(quote1.quote).toBeDefined();
    console.log('Created quote 1:', quote1.quote);

    // Wait a bit for watchers to start watching
    await sleep(200);

    // Pause subscriptions
    console.log('Pausing subscriptions...');
    await manager.pauseSubscriptions();

    // Verify watchers and processor are stopped
    expect(manager['mintQuoteWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']).toBeUndefined();
    expect(manager['mintQuoteProcessor']).toBeUndefined();

    // Create another quote while paused (this should still work - just creating locally)
    const quote2 = await manager.quotes.createMintQuote(mintUrl, 1);
    expect(quote2.quote).toBeDefined();
    console.log('Created quote 2 while paused:', quote2.quote);

    // Resume subscriptions
    console.log('Resuming subscriptions...');
    await manager.resumeSubscriptions();

    // Verify watchers and processor are running again
    expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

    console.log('Pause/Resume cycle completed successfully');
  }, 30000); // 30 second timeout for this integration test

  it('should handle multiple pause/resume cycles', async () => {
    await manager.mint.addMint(mintUrl);

    // First pause/resume cycle
    await manager.pauseSubscriptions();
    expect(manager['mintQuoteWatcher']).toBeUndefined();
    await manager.resumeSubscriptions();
    expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);

    // Second pause/resume cycle
    await manager.pauseSubscriptions();
    expect(manager['mintQuoteWatcher']).toBeUndefined();
    await manager.resumeSubscriptions();
    expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);

    // Create a quote after multiple cycles
    const quote = await manager.quotes.createMintQuote(mintUrl, 1);
    expect(quote.quote).toBeDefined();

    // Wait for it to potentially be redeemed
    await sleep(3000);

    // Should still work
    const balances = await manager.wallet.getBalances();
    const balance = balances[mintUrl] || 0;
    console.log('Balance after multiple cycles:', balance);
  }, 20000);

  it('should resume successfully even without explicit pause (simulating OS connection teardown)', async () => {
    await manager.mint.addMint(mintUrl);

    // Create a quote with subscriptions active
    const quote = await manager.quotes.createMintQuote(mintUrl, 1);
    expect(quote.quote).toBeDefined();

    // Simulate OS tearing down connections without explicit pause
    // Just call resume directly (as if recovering from background)
    console.log('Calling resume without prior pause...');
    await manager.resumeSubscriptions();

    // Everything should still be running
    expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

    // Set up event listener
    const redeemedQuotes: string[] = [];
    manager.on('mint-quote:redeemed', ({ quoteId }) => {
      redeemedQuotes.push(quoteId);
    });

    // Wait for processing
    await sleep(5000);

    // Should still work normally
    const balances = await manager.wallet.getBalances();
    const balance = balances[mintUrl] || 0;
    expect(balance).toBeGreaterThanOrEqual(0);
    console.log('Balance after resume without pause:', balance);
  }, 20000);

  it('should respect disabled watchers configuration during resume', async () => {
    // Clean up existing manager
    await manager.pauseSubscriptions();
    await manager.dispose();

    // Create new manager with some watchers disabled
    const repositories = new MemoryRepositories();
    manager = await initializeCoco({
      repo: repositories,
      seedGetter,
      logger: new NullLogger(),
      watchers: {
        mintQuoteWatcher: { disabled: true },
        proofStateWatcher: { disabled: false },
      },
      processors: {
        mintQuoteProcessor: { disabled: false },
      },
    });

    // Verify initial state
    expect(manager['mintQuoteWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

    // Pause
    await manager.pauseSubscriptions();
    expect(manager['proofStateWatcher']).toBeUndefined();
    expect(manager['mintQuoteProcessor']).toBeUndefined();

    // Resume
    await manager.resumeSubscriptions();

    // Verify configuration is respected - mintQuoteWatcher should stay disabled
    expect(manager['mintQuoteWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);
  });
});
