import type { EventBus, CoreEvents } from '../../events/index.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/index.ts';
import type { Repositories } from '../../repositories/index.ts';
import { OperationEventOutboxPublisher } from '../OperationEventOutboxPublisher.ts';

export interface MintSwapOperationProcessorOptions {
  sweepIntervalMs?: number;
  dueBatchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
}

export class MintSwapOperationProcessor {
  private readonly sweepIntervalMs: number;
  private readonly dueBatchSize: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly outbox: OperationEventOutboxPublisher;
  private running = false;
  private sweeping = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly tasks = new Set<Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly offs: Array<() => void> = [];

  constructor(
    private readonly service: MintSwapOperationService,
    private readonly repositories: Repositories,
    private readonly bus: EventBus<CoreEvents>,
    private readonly logger?: Logger,
    options: MintSwapOperationProcessorOptions = {},
  ) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? 5_000;
    this.dueBatchSize = options.dueBatchSize ?? 50;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1_000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.outbox = new OperationEventOutboxPublisher(
      repositories.operationEventOutboxRepository,
      bus,
      logger,
      options,
    );
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.subscribeWakeups();
    await this.sweep();
    this.schedule();
    this.logger?.info('MintSwapOperationProcessor started');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.offs.splice(0)) off();
    await Promise.allSettled(Array.from(this.tasks));
    this.logger?.info('MintSwapOperationProcessor stopped');
  }

  async recover(): Promise<void> {
    const active = await this.repositories.mintSwapOperationRepository.getActive();
    for (const operation of active) this.enqueue(operation.id);
    await Promise.allSettled(Array.from(this.tasks));
    await this.outbox.publishDue();
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const due = await this.repositories.mintSwapOperationRepository.getDue(
        now,
        this.dueBatchSize,
      );
      for (const operation of due) this.enqueue(operation.id);
      await this.outbox.publishDue(now);
    } finally {
      this.sweeping = false;
    }
  }

  private subscribeWakeups(): void {
    const wakeByMintChild = async ({ operationId }: { operationId: string }) => {
      const parent =
        await this.repositories.mintSwapOperationRepository.getByDestinationMintOperationId(
          operationId,
        );
      if (parent) this.enqueue(parent.id);
    };
    const wakeByMeltChild = async ({ operationId }: { operationId: string }) => {
      const parent =
        await this.repositories.mintSwapOperationRepository.getBySourceMeltOperationId(operationId);
      if (parent) this.enqueue(parent.id);
    };
    this.offs.push(
      this.bus.on('mint-op:finalized', wakeByMintChild),
      this.bus.on('mint-op:failed', wakeByMintChild),
      this.bus.on('melt-op:finalized', wakeByMeltChild),
      this.bus.on('melt-op:rolled-back', wakeByMeltChild),
      this.bus.on('mint-quote:updated', async ({ mintUrl, method, quoteId }) => {
        const active = await this.repositories.mintSwapOperationRepository.getActive();
        for (const operation of active) {
          const ref = operation.destinationQuoteRef;
          if (ref?.mintUrl === mintUrl && ref.method === method && ref.quoteId === quoteId) {
            this.enqueue(operation.id);
          }
        }
      }),
      this.bus.on('melt-quote:updated', async ({ mintUrl, method, quoteId }) => {
        const active = await this.repositories.mintSwapOperationRepository.getActive();
        for (const operation of active) {
          const ref = operation.sourceQuoteRef;
          if (ref?.mintUrl === mintUrl && ref.method === method && ref.quoteId === quoteId) {
            this.enqueue(operation.id);
          }
        }
      }),
    );
  }

  private enqueue(operationId: string): void {
    if (!this.running || this.queued.has(operationId)) return;
    this.queued.add(operationId);
    const task = this.process(operationId).finally(() => {
      this.queued.delete(operationId);
      this.tasks.delete(task);
    });
    this.tasks.add(task);
  }

  private async process(operationId: string): Promise<void> {
    try {
      await this.service.refresh(operationId);
      await this.service.recordProcessorSuccess(operationId);
      await this.outbox.publishDue();
    } catch (error) {
      const operation = await this.service.get(operationId);
      if (
        !operation ||
        operation.state === 'completed' ||
        operation.state === 'cancelled' ||
        operation.state === 'failed' ||
        operation.state === 'needs_attention'
      ) {
        return;
      }
      const attempt = operation.retry.attemptCount + 1;
      const delay = Math.min(
        this.maxRetryDelayMs,
        this.baseRetryDelayMs * 2 ** Math.min(attempt - 1, 16),
      );
      const message = error instanceof Error ? error.message : String(error);
      await this.service.recordProcessorFailure(operationId, message, Date.now() + delay);
      this.logger?.warn('Mint swap reconciliation delayed', {
        operationId,
        attempt,
        nextAttemptInMs: delay,
        error: message,
      });
    }
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const task = this.sweep()
        .catch((error) => {
          this.logger?.warn('Mint swap periodic sweep failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.tasks.delete(task);
          this.schedule();
        });
      this.tasks.add(task);
    }, this.sweepIntervalMs);
  }
}
