import type { EventBus, CoreEvents } from '../../events/index.ts';
import type { Logger } from '../../logging/Logger.ts';
import { redactError } from '../../logging/redaction.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/index.ts';
import type { Repositories } from '../../repositories/index.ts';
import { OperationInProgressError } from '../../models/Error.ts';
import { OperationEventOutboxPublisher } from '../OperationEventOutboxPublisher.ts';

export interface MintSwapOperationProcessorOptions {
  sweepIntervalMs?: number;
  dueBatchSize?: number;
  /** @deprecated Use the state-specific retry delay options. */
  baseRetryDelayMs?: number;
  /** @deprecated Use the state-specific retry delay options. */
  maxRetryDelayMs?: number;
  sourceBaseRetryDelayMs?: number;
  sourceMaxRetryDelayMs?: number;
  postPaymentBaseRetryDelayMs?: number;
  postPaymentMaxRetryDelayMs?: number;
  outboxBaseRetryDelayMs?: number;
  outboxMaxRetryDelayMs?: number;
  /** @internal Deterministic jitter source for tests. */
  random?: () => number;
}

export class MintSwapOperationProcessor {
  private readonly sweepIntervalMs: number;
  private readonly dueBatchSize: number;
  private readonly sourceBaseRetryDelayMs: number;
  private readonly sourceMaxRetryDelayMs: number;
  private readonly postPaymentBaseRetryDelayMs: number;
  private readonly postPaymentMaxRetryDelayMs: number;
  private readonly random: () => number;
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
    this.sourceBaseRetryDelayMs =
      options.sourceBaseRetryDelayMs ?? options.baseRetryDelayMs ?? 1_000;
    this.sourceMaxRetryDelayMs = options.sourceMaxRetryDelayMs ?? options.maxRetryDelayMs ?? 30_000;
    this.postPaymentBaseRetryDelayMs =
      options.postPaymentBaseRetryDelayMs ?? options.baseRetryDelayMs ?? 2_000;
    this.postPaymentMaxRetryDelayMs =
      options.postPaymentMaxRetryDelayMs ?? options.maxRetryDelayMs ?? 300_000;
    this.random = options.random ?? Math.random;
    this.outbox = new OperationEventOutboxPublisher(
      repositories.operationEventOutboxRepository,
      bus,
      logger,
      {
        baseRetryDelayMs: options.outboxBaseRetryDelayMs,
        maxRetryDelayMs: options.outboxMaxRetryDelayMs,
        random: options.random,
      },
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
      // A foreground command owns the parent lock. It will persist the next durable state and a
      // later event/sweep can reconcile it; this is not a remote failure and needs no backoff.
      if (error instanceof OperationInProgressError) return;
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
      const afterPayment =
        operation.state === 'destination_funded' || operation.state === 'issuing';
      const baseDelay = afterPayment
        ? this.postPaymentBaseRetryDelayMs
        : this.sourceBaseRetryDelayMs;
      const maxDelay = afterPayment ? this.postPaymentMaxRetryDelayMs : this.sourceMaxRetryDelayMs;
      const retryCeiling = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt - 1, 16));
      const delay = Math.floor(this.random() * Math.max(1, retryCeiling));
      const message = redactError(error);
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
            error: redactError(error),
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
