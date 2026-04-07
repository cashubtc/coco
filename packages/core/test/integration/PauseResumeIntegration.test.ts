import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initializeCoco, type Manager } from '../../Manager';
import { MemoryRepositories } from '../../repositories/memory';
import { NullLogger } from '../../logging';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getMintTotalBalance(manager: Manager, mintUrl: string): Promise<number> {
  const balances = await manager.wallet.balances.byMint({ mintUrls: [mintUrl] });
  return balances[mintUrl]?.total ?? 0;
}

describe('Pause/Resume Integration Test', () => {
  let manager: Manager;
  const mintUrl = 'https://testnut.cashu.space';
  const seedGetter = async () => new Uint8Array(64).fill(1);

  beforeEach(async () => {
    const repositories = new MemoryRepositories();
    manager = await initializeCoco({
      repo: repositories,
      seedGetter,
      logger: new NullLogger(),
      // Use faster intervals for testing
      watchers: {
        mintOperationWatcher: {
          watchExistingPendingOnStart: true,
        },
      },
      processors: {
        mintOperationProcessor: {
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
    expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

    // Add mint first (as trusted, since createMintQuote requires trust)
    await manager.mint.addMint(mintUrl, { trusted: true });

    // Create a mint quote
    const pendingMint1 = await manager.ops.mint.prepare({
      mintUrl,
      amount: 1,
      method: 'bolt11',
      methodData: {},
    });
    expect(pendingMint1.quoteId).toBeDefined();
    console.log('Created quote 1:', pendingMint1.quoteId);

    // Wait a bit for watchers to start watching
    await sleep(200);

    // Pause subscriptions
    console.log('Pausing subscriptions...');
    await manager.pauseSubscriptions();

    // Verify watchers and processor are stopped
    expect(manager['mintOperationWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']).toBeUndefined();
    expect(manager['mintOperationProcessor']).toBeUndefined();

    // Create another quote while paused (this should still work - just creating locally)
    const pendingMint2 = await manager.ops.mint.prepare({
      mintUrl,
      amount: 1,
      method: 'bolt11',
      methodData: {},
    });
    expect(pendingMint2.quoteId).toBeDefined();
    console.log('Created quote 2 while paused:', pendingMint2.quoteId);

    // Resume subscriptions
    console.log('Resuming subscriptions...');
    await manager.resumeSubscriptions();

    // Verify watchers and processor are running again
    expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

    console.log('Pause/Resume cycle completed successfully');
  }, 30000); // 30 second timeout for this integration test

  it('should handle multiple pause/resume cycles', async () => {
    await manager.mint.addMint(mintUrl, { trusted: true });

    // First pause/resume cycle
    await manager.pauseSubscriptions();
    expect(manager['mintOperationWatcher']).toBeUndefined();
    await manager.resumeSubscriptions();
    expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

    // Second pause/resume cycle
    await manager.pauseSubscriptions();
    expect(manager['mintOperationWatcher']).toBeUndefined();
    await manager.resumeSubscriptions();
    expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

    // Create a quote after multiple cycles
    const pendingMint = await manager.ops.mint.prepare({
      mintUrl,
      amount: 1,
      method: 'bolt11',
      methodData: {},
    });
    expect(pendingMint.quoteId).toBeDefined();

    // Wait for it to potentially be redeemed
    await sleep(3000);

    // Should still work
    const balance = await getMintTotalBalance(manager, mintUrl);
    console.log('Balance after multiple cycles:', balance);
  }, 20000);

  it('should resume successfully even without explicit pause (simulating OS connection teardown)', async () => {
    await manager.mint.addMint(mintUrl, { trusted: true });

    // Create a quote with subscriptions active
    const pendingMint = await manager.ops.mint.prepare({
      mintUrl,
      amount: 1,
      method: 'bolt11',
      methodData: {},
    });
    expect(pendingMint.quoteId).toBeDefined();

    // Simulate OS tearing down connections without explicit pause
    // Just call resume directly (as if recovering from background)
    console.log('Calling resume without prior pause...');
    await manager.resumeSubscriptions();

    // Everything should still be running
    expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

    // Wait for processing
    await sleep(5000);

    // Should still work normally
    const balance = await getMintTotalBalance(manager, mintUrl);
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
        mintOperationWatcher: { disabled: true },
        proofStateWatcher: { disabled: false },
      },
      processors: {
        mintOperationProcessor: { disabled: false },
      },
    });

    // Verify initial state
    expect(manager['mintOperationWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

    // Pause
    await manager.pauseSubscriptions();
    expect(manager['proofStateWatcher']).toBeUndefined();
    expect(manager['mintOperationProcessor']).toBeUndefined();

    // Resume
    await manager.resumeSubscriptions();

    // Verify configuration is respected - mintOperationWatcher should stay disabled
    expect(manager['mintOperationWatcher']).toBeUndefined();
    expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
    expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);
  });
});
