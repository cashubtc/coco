import { describe, it, beforeEach, expect, mock } from 'bun:test';
import { initializeCoco, type CocoConfig, Manager } from '../Manager';
import { MemoryRepositories } from '../repositories/memory';
import { NullLogger } from '../logging';

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
      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      // Verify processor is running
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should initialize repositories', async () => {
      const initSpy = mock(() => Promise.resolve());
      const mockRepo = {
        ...repositories,
        init: initSpy,
      };

      await initializeCoco({
        ...baseConfig,
        repo: mockRepo,
      });

      expect(initSpy).toHaveBeenCalled();
    });

    it('should use NullLogger by default', async () => {
      const manager = await initializeCoco(baseConfig);

      expect(manager['logger']).toBeInstanceOf(NullLogger);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should accept custom logger', async () => {
      const customLogger = new NullLogger();
      const manager = await initializeCoco({
        ...baseConfig,
        logger: customLogger,
      });

      expect(manager['logger']).toBe(customLogger);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });
  });

  describe('watchers configuration', () => {
    it('should disable mintQuoteWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: { disabled: true },
        },
      });

      expect(manager['mintQuoteWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should disable proofStateWatcher when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          proofStateWatcher: { disabled: true },
        },
      });

      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should disable all watchers when all are explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
      });

      expect(manager['mintQuoteWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteProcessor();
    });

    it('should pass options to mintQuoteWatcher when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: {
            watchExistingPendingOnStart: false,
          },
        },
      });

      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: {
            disabled: false,
            watchExistingPendingOnStart: true,
          },
        },
      });

      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });
  });

  describe('processors configuration', () => {
    it('should disable mintQuoteProcessor when explicitly disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintQuoteProcessor: { disabled: true },
        },
      });

      expect(manager['mintQuoteProcessor']).toBeUndefined();
      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
    });

    it('should pass options to mintQuoteProcessor when not disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintQuoteProcessor: {
            processIntervalMs: 5000,
            maxRetries: 3,
          },
        },
      });

      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should enable with options even when disabled is explicitly false', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {
          mintQuoteProcessor: {
            disabled: false,
            processIntervalMs: 1000,
          },
        },
      });

      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });
  });

  describe('mixed configuration', () => {
    it('should handle mixed enabled/disabled watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: false },
        },
        processors: {
          mintQuoteProcessor: { disabled: false },
        },
      });

      expect(manager['mintQuoteWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should support options with mixed configuration', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: {
            watchExistingPendingOnStart: false,
          },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintQuoteProcessor: {
            processIntervalMs: 10000,
            maxRetries: 5,
          },
        },
      });

      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableMintQuoteProcessor();
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

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });
  });

  describe('edge cases', () => {
    it('should handle empty watchers config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
      });

      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should handle empty processors config object', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        processors: {},
      });

      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should handle empty config objects for both watchers and processors', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {},
        processors: {},
      });

      expect(manager['mintQuoteWatcher']?.isRunning()).toBe(true);
      expect(manager['proofStateWatcher']?.isRunning()).toBe(true);
      expect(manager['mintQuoteProcessor']?.isRunning()).toBe(true);

      await manager.disableMintQuoteWatcher();
      await manager.disableProofStateWatcher();
      await manager.disableMintQuoteProcessor();
    });

    it('should handle all features disabled', async () => {
      const manager = await initializeCoco({
        ...baseConfig,
        watchers: {
          mintQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintQuoteProcessor: { disabled: true },
        },
      });

      expect(manager['mintQuoteWatcher']).toBeUndefined();
      expect(manager['proofStateWatcher']).toBeUndefined();
      expect(manager['mintQuoteProcessor']).toBeUndefined();

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
          mintQuoteWatcher: { disabled: true },
          proofStateWatcher: { disabled: true },
        },
        processors: {
          mintQuoteProcessor: { disabled: true },
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
});
