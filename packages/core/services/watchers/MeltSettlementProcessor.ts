import type { EventBus, CoreEvents } from '@core/events';
import type { MeltQuoteOperationInterest } from '@core/services/watchers/MeltQuoteWatcherService.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import type { MeltOperation, PendingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { MeltMethod } from '../../operations/melt/MeltMethodHandler.ts';
import { normalizeMintUrl } from '../../utils.ts';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

interface OperationInterestRegistrar {
  registerOperationInterest(interest: MeltQuoteOperationInterest): Promise<void>;
  removeOperationInterest(operationId: string): Promise<void>;
}

export interface MeltSettlementProcessorOptions {
  initializeExistingPendingOperationsOnStart?: boolean;
  interestRegistrar?: OperationInterestRegistrar;
}

function toKey(mintUrl: string, method: MeltMethod, quoteId: string): QuoteKey {
  return `${normalizeMintUrl(mintUrl)}::${method}::${quoteId}`;
}

function isPendingMeltOperation(operation: MeltOperation): operation is PendingMeltOperation {
  return operation.state === 'pending';
}

class MeltSettlementInterestRegistry {
  private readonly operationIdsByQuoteKey = new Map<QuoteKey, Set<string>>();
  private readonly quoteKeyByOperationId = new Map<string, QuoteKey>();

  add(operation: PendingMeltOperation): boolean {
    const key = toKey(operation.mintUrl, operation.method, operation.quoteId);
    const existingKey = this.quoteKeyByOperationId.get(operation.id);
    if (existingKey === key) {
      return false;
    }

    if (existingKey) {
      this.remove(operation.id);
    }

    let operationIds = this.operationIdsByQuoteKey.get(key);
    if (!operationIds) {
      operationIds = new Set<string>();
      this.operationIdsByQuoteKey.set(key, operationIds);
    }

    operationIds.add(operation.id);
    this.quoteKeyByOperationId.set(operation.id, key);
    return true;
  }

  remove(operationId: string): boolean {
    const key = this.quoteKeyByOperationId.get(operationId);
    if (!key) {
      return false;
    }

    this.quoteKeyByOperationId.delete(operationId);
    const operationIds = this.operationIdsByQuoteKey.get(key);
    operationIds?.delete(operationId);
    if (operationIds?.size === 0) {
      this.operationIdsByQuoteKey.delete(key);
    }
    return true;
  }

  getOperationIds(mintUrl: string, method: MeltMethod, quoteId: string): string[] {
    return Array.from(this.operationIdsByQuoteKey.get(toKey(mintUrl, method, quoteId)) ?? []);
  }

  getAllOperationIds(): string[] {
    return Array.from(this.quoteKeyByOperationId.keys());
  }
}

export class MeltSettlementProcessor {
  private readonly meltOperations: MeltOperationService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: Required<Omit<MeltSettlementProcessorOptions, 'interestRegistrar'>>;
  private readonly interestRegistrar?: OperationInterestRegistrar;

  private running = false;
  private offPending?: () => void;
  private offQuoteUpdated?: () => void;
  private offFinalized?: () => void;
  private offRolledBack?: () => void;
  private readonly interests = new MeltSettlementInterestRegistry();
  private readonly inFlightOperationIds = new Set<string>();
  private readonly inFlightChecks = new Set<Promise<void>>();

  constructor(
    meltOperations: MeltOperationService,
    bus: EventBus<CoreEvents>,
    logger?: Logger,
    options: MeltSettlementProcessorOptions = {},
  ) {
    this.meltOperations = meltOperations;
    this.bus = bus;
    this.logger = logger;
    this.options = {
      initializeExistingPendingOperationsOnStart:
        options.initializeExistingPendingOperationsOnStart ?? true,
    };
    this.interestRegistrar = options.interestRegistrar;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.logger?.info('MeltSettlementProcessor started');

    this.offPending = this.bus.on('melt-op:pending', async ({ operation }) => {
      if (isPendingMeltOperation(operation)) {
        await this.registerOperationInterest(operation);
      }
    });

    this.offQuoteUpdated = this.bus.on(
      'melt-quote:updated',
      async ({ mintUrl, method, quoteId, quote }) => {
        const operationIds = this.interests.getOperationIds(mintUrl, method, quoteId);
        if (operationIds.length === 0) {
          return;
        }

        await Promise.all(
          operationIds.map((operationId) =>
            this.checkInterestedOperation(operationId, {
              mintUrl: quote.mintUrl,
              method: quote.method,
              quoteId: quote.quoteId,
            }),
          ),
        );
      },
    );

    this.offFinalized = this.bus.on('melt-op:finalized', async ({ operationId }) => {
      await this.removeOperationInterest(operationId);
    });

    this.offRolledBack = this.bus.on('melt-op:rolled-back', async ({ operationId }) => {
      await this.removeOperationInterest(operationId);
    });

    if (this.options.initializeExistingPendingOperationsOnStart) {
      await this.initializeExistingPendingOperations();
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    const unsubscribe = (off: (() => void) | undefined) => {
      try {
        off?.();
      } catch {
        // ignore unsubscribe failures
      }
    };
    unsubscribe(this.offPending);
    unsubscribe(this.offQuoteUpdated);
    unsubscribe(this.offFinalized);
    unsubscribe(this.offRolledBack);
    this.offPending = undefined;
    this.offQuoteUpdated = undefined;
    this.offFinalized = undefined;
    this.offRolledBack = undefined;

    while (this.inFlightChecks.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightChecks));
    }

    const operationIds = this.interests.getAllOperationIds();
    for (const operationId of operationIds) {
      await this.removeOperationInterest(operationId);
    }
    this.inFlightOperationIds.clear();
    this.logger?.info('MeltSettlementProcessor stopped');
  }

  private async initializeExistingPendingOperations(): Promise<void> {
    try {
      const operations = await this.meltOperations.getPendingOperations();
      for (const operation of operations) {
        if (isPendingMeltOperation(operation)) {
          await this.registerOperationInterest(operation);
        }
      }
    } catch (err) {
      this.logger?.warn('Failed to initialize pending melt settlement interest', { err });
    }
  }

  private async registerOperationInterest(operation: PendingMeltOperation): Promise<void> {
    const added = this.interests.add(operation);
    if (!added) {
      return;
    }

    this.logger?.debug('Registered melt settlement interest', {
      operationId: operation.id,
      mintUrl: operation.mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
    });

    try {
      await this.interestRegistrar?.registerOperationInterest({
        operationId: operation.id,
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      });
    } catch (err) {
      this.logger?.warn('Failed to register melt quote operation watch interest', {
        operationId: operation.id,
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
        err,
      });
    }
  }

  private async removeOperationInterest(operationId: string): Promise<void> {
    const removed = this.interests.remove(operationId);
    if (!removed) {
      return;
    }

    this.logger?.debug('Removed melt settlement interest', { operationId });

    try {
      await this.interestRegistrar?.removeOperationInterest(operationId);
    } catch (err) {
      this.logger?.warn('Failed to remove melt quote operation watch interest', {
        operationId,
        err,
      });
    }
  }

  private checkInterestedOperation(
    operationId: string,
    quote: { mintUrl: string; method: MeltMethod; quoteId: string },
  ): Promise<void> {
    if (this.inFlightOperationIds.has(operationId)) {
      this.logger?.debug('Melt settlement check already in flight', {
        operationId,
        mintUrl: quote.mintUrl,
        method: quote.method,
        quoteId: quote.quoteId,
      });
      return Promise.resolve();
    }

    this.inFlightOperationIds.add(operationId);
    const check = (async () => {
      try {
        await this.meltOperations.checkPendingOperation(operationId);
      } catch (err) {
        this.logger?.warn('Failed to settle pending melt operation', {
          operationId,
          mintUrl: quote.mintUrl,
          method: quote.method,
          quoteId: quote.quoteId,
          err,
        });
      } finally {
        this.inFlightOperationIds.delete(operationId);
      }
    })();

    this.inFlightChecks.add(check);
    check.finally(() => {
      this.inFlightChecks.delete(check);
    });
    return check;
  }
}
