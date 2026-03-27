import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { initializeCoco, type CocoConfig, Manager } from '../../Manager';
import { PaymentRequestsApi } from '../../api/PaymentRequestsApi';
import { MemoryRepositories } from '../../repositories/memory';
import { NullLogger } from '../../logging';

describe('initializeCoco', () => {
  let repositories: MemoryRepositories;
  let seedGetter: () => Promise<Uint8Array>;
  let baseConfig: Pick<CocoConfig, 'repo' | 'seedGetter'>;

  beforeEach(() => {
    repositories = new MemoryRepositories();
    seedGetter = async () => new Uint8Array(32);
    baseConfig = {
      repo: repositories,
      seedGetter,
    };
  });

  describe('default behavior', () => {
    it('should enable all watchers and processors by default', async () => {
      const manager = await initializeCoco(baseConfig);

      // Check that manager is created
      expect(manager).toBeInstanceOf(Manager);

      // Verify watchers are running (they have isRunning methods)
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      // Verify processor is running
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should initialize repositories', async () => {
      const initSpy = mock(() => Promise.resolve());
      const mockRepo = Object.assign(Object.create(repositories), {
        init: initSpy,
      });

      await initializeCoco({
        ...baseConfig,
        repo: mockRepo,
      });

      expect(initSpy).toHaveBeenCalled();
    });

    it('should expose the dedicated payment requests api', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager.paymentRequests).toBeInstanceOf(PaymentRequestsApi);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should use NullLogger by default', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['logger']).toBeInstanceOf(NullLogger);
      expect(manager.ops.send).toBe(manager.send);
      expect(manager.ops.receive).toBe(manager.receive);
      expect(manager.ops.mint).toBeDefined();
      expect(manager.ops.melt).toBeDefined();

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should accept custom logger', async () => {
      const customLogger = new NullLogger();
      const manager = await initializeCoco({
        ...baseConfig,
        logger: customLogger,
      });

      expect(manager['logger']).toBe(customLogger);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });
  });

  describe('watchers configuration', () => {
    it('should disable mintOperationWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should disable proofStateWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          proofStateWatcher: { disabled: true },
        },
      });

      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should disable all watchers when all are explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationProcessor();
    });

    it('should pass options to mintOperationWatcher when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            watchExistingPendingOnStart: false,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            disabled: false,
            watchExistingPendingOnStart: true,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });
  });

  describe('processors configuration', () => {
    it('should disable mintOperationProcessor when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationProcessor']).toBeUndefined();
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
    });

    it('should pass options to mintOperationProcessor when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: {
            processIntervalMs: 5000,
            maxRetries: 3,
          },
        },
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintOperationProcessor: {
            disabled: false,
            processIntervalMs: 1000,
          },
        },
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });
  });

  describe('mixed configuration', () => {
    it('should handle mixed enabled/disabled watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: false },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should support options with mixed configuration', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: {
            watchExistingPendingOnStart: false,
          },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: {
            processIntervalMs: 10000,
            maxRetries: 5,
          },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableMintOperationProcessor();
    });
  });

  describe('plugins', () => {
    it('should initialize with plugins', async () => {
      const pluginInitMock = mock(() => {});
      const plugin = {
        name: 'test-plugin',
        required: [] as const,
        onInit: pluginInitMock,
      };

      const manager = await initializeCoco({
        ...baseConfig,
        plugins: [plugin],
      });

      // Wait a bit for async plugin initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(pluginInitMock).toHaveBeenCalled();

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });
  });

  describe('edge cases', () => {
    it('should handle empty watchers config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should handle empty processors config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {},
      });

      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should handle empty config objects for both watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
        processors: {},
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should handle all features disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();

      // Should still have API access
      expect(manager.mint).toBeDefined();
      expect(manager.wallet).toBeDefined();
      expect(manager.quotes).toBeDefined();
    });
  });

  describe('API availability', () => {
    it('should expose all public APIs regardless of watcher/processor config', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(manager.mint).toBeDefined();
      expect(manager.wallet).toBeDefined();
      expect(manager.quotes).toBeDefined();
      expect(manager.subscription).toBeDefined();
      expect(manager.history).toBeDefined();
      expect(manager.subscriptions).toBeDefined();
    });
  });

  describe('pause and resume subscriptions', () => {
    it('should pause and stop all watchers and processors', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.pauseSubscriptions();

      // After pause, watchers and processor are disabled (set to undefined)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
    });

    it('should resume and restart all watchers and processors', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should be idempotent - multiple pause calls should not error', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.pauseSubscriptions();
      await manager.pauseSubscriptions();

      // After pause, watchers and processor are disabled (set to undefined)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
    });

    it('should be idempotent - multiple resume calls should not error', async () => {
      const manager = await initializeCoco(baseConfig);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();
      await manager.resumeSubscriptions();
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should handle resume without prior pause (OS connection teardown scenario)', async () => {
      const manager = await initializeCoco(baseConfig);

      // Simulate OS killing connections - just call resume without pause
      await manager.resumeSubscriptions();

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should respect original configuration - disabled watchers stay disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: false },
        },
      });

      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // mintOperationWatcher should remain undefined (was disabled)
      expect(manager['mintOperationWatcher']).toBeUndefined();
      // Others should be running again
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintOperationProcessor();
    });

    it('should respect original configuration - disabled processor stays disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: false },
          proofStateWatcher: { disabled: false },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintOperationProcessor']).toBeUndefined();

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // Watchers should be running again
      expect(manager['mintOperationWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      // Processor should remain undefined (was disabled)
      expect(manager['mintOperationProcessor']).toBeUndefined();

      await manager.disableMintOperationWatcher();
      await manager.disableProofStateWatcher();
    });

    it('should handle all features disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintOperationWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintOperationProcessor: { disabled: true },
        },
      });

      await manager.pauseSubscriptions();
      await manager.resumeSubscriptions();

      // All should remain undefined
      expect(manager['mintOperationWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintOperationProcessor']).toBeUndefined();
    });
  });
});
