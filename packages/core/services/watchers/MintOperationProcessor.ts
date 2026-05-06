import type { EventBus, CoreEvents } from '@core/events';
import type { Logger } from '../../logging/Logger.ts';
import type { MintOperationService } from '@core/operations/mint';
import { MintOperationError, NetworkError } from '../../models/Error';

interface QueueItem {
  mintUrl: string;
  operationId: string;
  method: string;
  retryCount: number;
  nextRetryAt: number;
}

interface OperationHandler {
  process(mintUrl: string, operationId: string): Promise<void>;
}

class Bolt11MintOperationHandler implements OperationHandler {
  constructor(
    private mintOperations: MintOperationService,
    private logger?: Logger,
  ) {}

  async process(_mintUrl: string, operationId: string): Promise<void> {
    await this.mintOperations.finalize(operationId);
  }
}

export interface MintOperationProcessorOptions {
  processIntervalMs?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  initialEnqueueDelayMs?: number;
}

export class MintOperationProcessor {
  private readonly mintOperations: MintOperationService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  private running = false;
  private queue: QueueItem[] = [];
  private readonly activeItems = new Set<string>();
  private processing = false;
  private processingTimer?: ReturnType<typeof setTimeout>;
  private offStateChanged?: () => void;
  private offPending?: () => void;
  private offRequeue?: () => void;
  private offUntrusted?: () => void;

  private handlers = new Map<string, OperationHandler>();
  private readonly processIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly initialEnqueueDelayMs: number;

  constructor(
    mintOperations: MintOperationService,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options?: MintOperationProcessorOptions,
  ) {
    this.mintOperations = mintOperations;
    this.bus = bus;
    this.logger = logger;

    // Apply options with defaults
    this.processIntervalMs = options?.processIntervalMs ?? 3000;
    this.maxRetries = options?.maxRetries ?? 3;
    this.baseRetryDelayMs = options?.baseRetryDelayMs ?? 5000;
    this.initialEnqueueDelayMs = options?.initialEnqueueDelayMs ?? 500;

    // Register default handler for bolt11 mint operations
    this.registerHandler('bolt11', new Bolt11MintOperationHandler(mintOperations, logger));
  }

  registerHandler(method: string, handler: OperationHandler): void {
    this.handlers.set(method, handler);
    this.logger?.debug('Registered mint operation handler', { method });
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger?.info('MintOperationProcessor started');

    // Subscribe to operation-owned quote-state changes
    this.offStateChanged = this.bus.on(
      'mint-op:quote-state-changed',
      async ({ mintUrl, operationId, operation, state }) => {
        if (state === 'PAID') {
          this.enqueue(mintUrl, operationId, operation.method);
        }
      },
    );

    // Subscribe to pending operations so imported PAID operations enqueue immediately
    this.offPending = this.bus.on('mint-op:pending', async ({ mintUrl, operation }) => {
      if (operation.state === 'pending' && operation.lastObservedRemoteState === 'PAID') {
        this.enqueue(mintUrl, operation.id, operation.method);
      }
    });

    // Subscribe to explicit operation requeue events.
    this.offRequeue = this.bus.on('mint-op:requeue', ({ mintUrl, operationId, operation }) => {
      this.enqueue(mintUrl, operationId, operation.method);
    });

    // Clear queue items when mint is untrusted
    this.offUntrusted = this.bus.on('mint:untrusted', ({ mintUrl }) => {
      this.clearMintFromQueue(mintUrl);
    });

    // Start processing loop
    this.scheduleNextProcess();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Unsubscribe from events
    if (this.offStateChanged) {
      try {
        this.offStateChanged();
      } catch {
        // ignore
      } finally {
        this.offStateChanged = undefined;
      }
    }

    if (this.offPending) {
      try {
        this.offPending();
      } catch {
        // ignore
      } finally {
        this.offPending = undefined;
      }
    }

    if (this.offRequeue) {
      try {
        this.offRequeue();
      } catch {
        // ignore
      } finally {
        this.offRequeue = undefined;
      }
    }

    if (this.offUntrusted) {
      try {
        this.offUntrusted();
      } catch {
        // ignore
      } finally {
        this.offUntrusted = undefined;
      }
    }

    // Clear processing timer
    if (this.processingTimer) {
      clearTimeout(this.processingTimer);
      this.processingTimer = undefined;
    }

    // Wait for current processing to complete
    while (this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    this.logger?.info('MintOperationProcessor stopped', { pendingItems: this.queue.length });
  }

  /**
   * Wait for the queue to be empty and all processing to complete.
   * Useful for CLI applications that want to ensure all queued operations are processed before exiting.
   */
  async waitForCompletion(): Promise<void> {
    while (this.queue.length > 0 || this.processing) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /**
   * Remove all queued items for a specific mint.
   * Called when a mint is untrusted to stop processing its operations.
   */
  clearMintFromQueue(mintUrl: string): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => item.mintUrl !== mintUrl);
    const removed = before - this.queue.length;
    if (removed > 0) {
      this.logger?.info('Cleared mint operations from processor queue', { mintUrl, removed });
    }
  }

  private queueKey(mintUrl: string, operationId: string): string {
    return `${mintUrl}::${operationId}`;
  }

  private enqueue(mintUrl: string, operationId: string, method: string): void {
    const key = this.queueKey(mintUrl, operationId);
    if (this.activeItems.has(key)) {
      this.logger?.debug('Mint operation already being processed', { mintUrl, operationId });
      return;
    }

    // Check if already in queue
    const existing = this.queue.find(
      (item) => item.mintUrl === mintUrl && item.operationId === operationId,
    );
    if (existing) {
      this.logger?.debug('Mint operation already in queue', { mintUrl, operationId });
      return;
    }

    const wasEmpty = this.queue.length === 0;

    this.queue.push({
      mintUrl,
      operationId,
      method,
      retryCount: 0,
      nextRetryAt: 0,
    });

    this.logger?.debug('Mint operation enqueued for processing', {
      mintUrl,
      operationId,
      method,
      queueLength: this.queue.length,
    });

    // If queue was empty and processor is idle, schedule a faster first run
    if (wasEmpty && this.running && !this.processing) {
      if (this.processingTimer) {
        clearTimeout(this.processingTimer);
        this.processingTimer = undefined;
      }
      this.processingTimer = setTimeout(() => {
        this.processingTimer = undefined;
        this.processNext();
      }, this.initialEnqueueDelayMs);
    }
  }

  private scheduleNextProcess(): void {
    if (!this.running || this.processingTimer) return;

    this.processingTimer = setTimeout(() => {
      this.processingTimer = undefined;
      this.processNext();
    }, this.processIntervalMs);
  }

  private async processNext(): Promise<void> {
    if (!this.running || this.processing || this.queue.length === 0) {
      if (this.running) {
        this.scheduleNextProcess();
      }
      return;
    }

    // Find next item that's ready to process
    const now = Date.now();
    const readyIndex = this.queue.findIndex((item) => item.nextRetryAt <= now);

    if (readyIndex === -1) {
      // No items ready yet, schedule for when the next one will be
      const nextReady = Math.min(...this.queue.map((item) => item.nextRetryAt));
      const delay = Math.max(this.processIntervalMs, nextReady - now);
      this.processingTimer = setTimeout(() => {
        this.processingTimer = undefined;
        this.processNext();
      }, delay);
      return;
    }

    // Remove item from queue
    const [item] = this.queue.splice(readyIndex, 1);
    if (!item) {
      // This shouldn't happen, but handle it gracefully
      return;
    }
    this.processing = true;
    const activeKeys = [this.queueKey(item.mintUrl, item.operationId)];
    this.activeItems.add(activeKeys[0]!);

    try {
      const extraActiveKeys = await this.processItem(item);
      activeKeys.push(...extraActiveKeys);
    } catch (err) {
      this.handleProcessingError(item, err);
    } finally {
      for (const key of activeKeys) {
        this.activeItems.delete(key);
      }
      this.processing = false;
      if (this.running) {
        this.scheduleNextProcess();
      }
    }
  }

  private async processItem(item: QueueItem): Promise<string[]> {
    const { mintUrl, operationId, method } = item;

    const handler = this.handlers.get(method);
    if (!handler) {
      this.logger?.warn('No handler registered for mint method', {
        method,
        mintUrl,
        operationId,
      });
      return [];
    }

    this.logger?.info('Processing mint operation', {
      mintUrl,
      operationId,
      method,
      attempt: item.retryCount + 1,
    });

    const operation =
      typeof (this.mintOperations as any).getOperation === 'function'
        ? await this.mintOperations.getOperation(operationId)
        : null;
    if (
      operation?.state === 'pending' &&
      operation.batchEligible &&
      !operation.outputData &&
      operation.lastObservedRemoteState === 'PAID'
    ) {
      const batchItems = await this.collectBatchItems(item, operation.unit);
      if (batchItems.length > 1) {
        const batchIds = batchItems.map((batchItem) => batchItem.operationId);
        const extraActiveKeys = batchItems
          .slice(1)
          .map((batchItem) => this.queueKey(batchItem.mintUrl, batchItem.operationId));
        for (const key of extraActiveKeys) {
          this.activeItems.add(key);
        }

        try {
          await this.mintOperations.finalizeBatch(batchIds);
          this.logger?.info('Successfully processed mint batch', {
            mintUrl,
            method,
            count: batchIds.length,
          });
          return extraActiveKeys;
        } catch (error) {
          this.logger?.warn('Mint batch processing failed, falling back to single operation', {
            mintUrl,
            operationId,
            method,
            count: batchIds.length,
            error: error instanceof Error ? error.message : String(error),
          });
          for (const key of extraActiveKeys) {
            this.activeItems.delete(key);
          }
          for (const batchItem of batchItems.slice(1)) {
            this.queue.push(batchItem);
          }
        }
      }
    }

    await handler.process(mintUrl, operationId);
    this.logger?.info('Successfully processed mint operation', { mintUrl, operationId, method });
    return [];
  }

  private async collectBatchItems(item: QueueItem, unit: string): Promise<QueueItem[]> {
    const batchItems = [item];
    const remaining: QueueItem[] = [];

    for (const candidate of this.queue) {
      if (candidate.mintUrl !== item.mintUrl || candidate.method !== item.method) {
        remaining.push(candidate);
        continue;
      }

      const operation = await this.mintOperations.getOperation(candidate.operationId);
      if (
        operation?.state === 'pending' &&
        operation.unit === unit &&
        operation.batchEligible &&
        !operation.outputData &&
        operation.lastObservedRemoteState === 'PAID'
      ) {
        batchItems.push(candidate);
      } else {
        remaining.push(candidate);
      }
    }

    this.queue = remaining;
    return batchItems;
  }

  private handleProcessingError(item: QueueItem, err: unknown): void {
    const { mintUrl, operationId } = item;

    if (err instanceof MintOperationError) {
      if (err.code === 20007) {
        this.logger?.warn('Mint operation quote expired', { mintUrl, operationId });
        return;
      }

      if (err.code === 20002) {
        this.logger?.info('Mint operation quote already issued', { mintUrl, operationId });
        return;
      }

      this.logger?.error('Mint operation error, not retrying', {
        mintUrl,
        operationId,
        code: err.code,
        detail: err.message,
      });
      return;
    }

    if (err instanceof NetworkError || (err instanceof Error && err.message.includes('network'))) {
      item.retryCount++;
      if (item.retryCount <= this.maxRetries) {
        const delay = this.baseRetryDelayMs * Math.pow(2, item.retryCount - 1);
        item.nextRetryAt = Date.now() + delay;

        this.logger?.warn('Network error, will retry', {
          mintUrl,
          operationId,
          attempt: item.retryCount,
          maxRetries: this.maxRetries,
          retryInMs: delay,
        });

        this.queue.push(item);
        return;
      }

      this.logger?.error('Max retries exceeded for network error', {
        mintUrl,
        operationId,
        maxRetries: this.maxRetries,
      });
      return;
    }

    this.logger?.error('Failed to process mint operation', { mintUrl, operationId, err });
  }
}
