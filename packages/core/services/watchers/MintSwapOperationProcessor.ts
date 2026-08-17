import type { CoreEvents, EventBus } from '../../events';
import type { Logger } from '../../logging/Logger.ts';
import type { MintSwapOperationService } from '../../operations/mintSwap/MintSwapOperationService.ts';
import type { MintSwapOperation } from '../../operations/mintSwap/MintSwapOperation.ts';
import { requireMintSwapRepositoryCapability, type Repositories } from '../../repositories';
import { OperationEventOutboxPublisher } from '../OperationEventOutboxPublisher.ts';

export interface MintSwapOperationProcessorOptions {
  sweepIntervalMs?: number;
  dueBatchSize?: number;
  now?: () => number;
  random?: () => number;
}

export class MintSwapOperationProcessor {
  private readonly sweepIntervalMs: number;
  private readonly dueBatchSize: number;
  private readonly now: () => number;
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
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.outbox = new OperationEventOutboxPublisher(
      requireMintSwapRepositoryCapability(repositories).operationEventOutboxRepository,
      bus,
      logger,
      { now: this.now, random: this.random },
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
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const off of this.offs.splice(0)) off();
    await Promise.allSettled([...this.tasks]);
  }

  async sweep(now = this.now()): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const repository = requireMintSwapRepositoryCapability(
        this.repositories,
      ).mintSwapOperationRepository;
      for (const operation of await repository.getDue(now, this.dueBatchSize)) {
        this.enqueue(operation.id);
      }
      await Promise.allSettled([...this.tasks]);
      await this.outbox.publishDue(now);
    } finally {
      this.sweeping = false;
    }
  }

  private subscribeWakeups(): void {
    const parentRepository = requireMintSwapRepositoryCapability(
      this.repositories,
    ).mintSwapOperationRepository;
    const wakeMintChild = async ({ operationId }: { operationId: string }) => {
      const parent = await parentRepository.getByDestinationMintOperationId(operationId);
      if (parent) this.enqueue(parent.id);
    };
    const wakeMeltChild = async ({ operationId }: { operationId: string }) => {
      const parent = await parentRepository.getBySourceMeltOperationId(operationId);
      if (parent) this.enqueue(parent.id);
    };
    const wakeQuote = async (identity: { mintUrl: string; method: string; quoteId: string }) => {
      for (const parent of await parentRepository.getActive()) {
        const refs = [parent.destinationQuoteRef, parent.sourceQuoteRef];
        if (
          refs.some(
            (ref) =>
              ref?.mintUrl === identity.mintUrl &&
              ref.method === identity.method &&
              ref.quoteId === identity.quoteId,
          )
        ) {
          this.enqueue(parent.id);
        }
      }
    };
    this.offs.push(
      this.bus.on('mint-op:finalized', wakeMintChild),
      this.bus.on('mint-op:failed', wakeMintChild),
      this.bus.on('melt-op:finalized', wakeMeltChild),
      this.bus.on('melt-op:rolled-back', wakeMeltChild),
      this.bus.on('mint-quote:updated', wakeQuote),
      this.bus.on('melt-quote:updated', wakeQuote),
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
      const operation = await this.service.reconcile(operationId);
      await this.service.recordProcessorSuccess(operationId);
      await this.outbox.publishDue();
      this.logger?.debug('Mint swap reconciliation completed', {
        operationId,
        state: operation.state,
      });
    } catch {
      const operation = await this.service.get(operationId);
      if (!operation || !isAutomatic(operation)) return;
      const delay = this.retryDelay(operation);
      if (await this.service.recordProcessorFailure(operationId, this.now() + delay)) {
        this.logger?.warn('Mint swap reconciliation delayed', {
          operationId,
          attempt: operation.retry.attemptCount + 1,
          nextAttemptInMs: delay,
        });
      }
    }
  }

  private retryDelay(operation: MintSwapOperation): number {
    const afterFunding = operation.state === 'destination_funded' || operation.state === 'issuing';
    const base = afterFunding ? 2_000 : 1_000;
    const cap = afterFunding ? 300_000 : 30_000;
    const ceiling = Math.min(cap, base * 2 ** Math.min(operation.retry.attemptCount, 16));
    return Math.floor(this.random() * Math.max(1, ceiling));
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const task = this.sweep()
        .catch(() => this.logger?.warn('Mint swap due sweep failed'))
        .finally(() => {
          this.tasks.delete(task);
          this.schedule();
        });
      this.tasks.add(task);
    }, this.sweepIntervalMs);
  }
}

function isAutomatic(operation: MintSwapOperation): boolean {
  return (
    operation.state === 'preparing' ||
    operation.state === 'source_inflight' ||
    operation.state === 'destination_funded' ||
    operation.state === 'issuing'
  );
}
