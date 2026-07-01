import type { EventBus, CoreEvents } from '@core/events';
import type { MeltQuoteOperationInterest } from '@core/services/watchers/MeltQuoteWatcherService.ts';
import type { Logger } from '../../logging/Logger.ts';
import type { MeltOperationService } from '../../operations/melt/MeltOperationService.ts';
import type { MeltOperation, PendingMeltOperation } from '../../operations/melt/MeltOperation.ts';
import type { MeltMethod } from '../../operations/melt/MeltMethodHandler.ts';
import { normalizeMintUrl } from '../../utils.ts';

type QuoteKey = string; // `${mintUrl}::${method}::${quoteId}`

interface OperationQuoteInterest {
  id: string;
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
}

interface OperationCheckContext {
  mintUrl: string;
  method: MeltMethod;
  quoteId: string;
}

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
  private readonly operationById = new Map<string, OperationQuoteInterest>();

  add(operation: OperationQuoteInterest): boolean {
    const key = toKey(operation.mintUrl, operation.method, operation.quoteId);
    const existingKey = this.quoteKeyByOperationId.get(operation.id);
    if (existingKey === key) {
      this.operationById.set(operation.id, operation);
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
    this.operationById.set(operation.id, operation);
    return true;
  }

  remove(operationId: string): boolean {
    const key = this.quoteKeyByOperationId.get(operationId);
    if (!key) {
      return false;
    }

    this.quoteKeyByOperationId.delete(operationId);
    this.operationById.delete(operationId);
    const operationIds = this.operationIdsByQuoteKey.get(key);
    operationIds?.delete(operationId);
    if (operationIds?.size === 0) {
      this.operationIdsByQuoteKey.delete(key);
    }
    return true;
  }

  has(operationId: string): boolean {
    return this.quoteKeyByOperationId.has(operationId);
  }

  getOperationIds(mintUrl: string, method: MeltMethod, quoteId: string): string[] {
    return Array.from(this.operationIdsByQuoteKey.get(toKey(mintUrl, method, quoteId)) ?? []);
  }

  getAllOperationIds(): string[] {
    return Array.from(this.quoteKeyByOperationId.keys());
  }

  getAllOperations(): OperationQuoteInterest[] {
    return Array.from(this.operationById.values());
  }
}

export class MeltSettlementProcessor {
  private readonly meltOperations: MeltOperationService;
  private readonly bus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly options: Required<Omit<MeltSettlementProcessorOptions, 'interestRegistrar'>>;
  private interestRegistrar?: OperationInterestRegistrar;

  private running = false;
  private offPending?: () => void;
  private offQuoteUpdated?: () => void;
  private offFinalized?: () => void;
  private offRolledBack?: () => void;
  private readonly interests = new MeltSettlementInterestRegistry();
  private readonly inFlightOperationIds = new Set<string>();
  private readonly followUpCheckByOperationId = new Map<string, OperationCheckContext>();
  private readonly registeredOperationInterestIds = new Set<string>();
  private readonly scheduledInitialCheckOperationIds = new Set<string>();
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

  /** @internal Rebinds the watcher that owns operation quote subscriptions. */
  async setInterestRegistrar(interestRegistrar?: OperationInterestRegistrar): Promise<void> {
    if (this.interestRegistrar === interestRegistrar) {
      if (this.running && interestRegistrar) {
        await this.registerTrackedOperationInterests();
      }
      return;
    }

    const previousRegistrar = this.interestRegistrar;
    const registeredOperationIds = Array.from(this.registeredOperationInterestIds);
    this.interestRegistrar = interestRegistrar;
    this.registeredOperationInterestIds.clear();

    if (previousRegistrar) {
      for (const operationId of registeredOperationIds) {
        await this.removeOperationWatchInterest(previousRegistrar, operationId);
      }
    }

    if (this.running && this.interestRegistrar) {
      await this.registerTrackedOperationInterests();
    }
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
    this.followUpCheckByOperationId.clear();
    this.registeredOperationInterestIds.clear();
    this.scheduledInitialCheckOperationIds.clear();
    this.logger?.info('MeltSettlementProcessor stopped');
  }

  private async initializeExistingPendingOperations(): Promise<void> {
    try {
      const operations = await this.meltOperations.getPendingOperations();
      if (!this.running) {
        return;
      }

      for (const operation of operations) {
        if (!this.running) {
          return;
        }
        if (isPendingMeltOperation(operation)) {
          await this.registerOperationInterest(operation);
        }
      }
    } catch (err) {
      this.logger?.warn('Failed to initialize pending melt settlement interest', { err });
    }
  }

  private async registerOperationInterest(operation: PendingMeltOperation): Promise<void> {
    if (!this.running) {
      return;
    }

    const mintUrl = normalizeMintUrl(operation.mintUrl);
    const operationInterest = {
      id: operation.id,
      mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
    };
    const added = this.interests.add(operationInterest);
    if (!added && !this.interestRegistrar) {
      return;
    }

    if (added) {
      this.logger?.debug('Registered melt settlement interest', {
        operationId: operation.id,
        mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      });
    }

    if (this.interestRegistrar) {
      const registered = await this.registerOperationWatchInterest(operationInterest);
      if (!registered) {
        if (added) {
          this.interests.remove(operation.id);
        }
        return;
      }
    }

    if (!this.running || !this.interests.has(operation.id)) {
      await this.removeRegisteredOperationInterest(operation.id);
      return;
    }

    this.scheduleInitialOperationCheck(operation.id, {
      mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
    });
  }

  private async removeOperationInterest(operationId: string): Promise<void> {
    const removed = this.interests.remove(operationId);
    if (!removed) {
      return;
    }

    this.followUpCheckByOperationId.delete(operationId);
    this.scheduledInitialCheckOperationIds.delete(operationId);
    this.logger?.debug('Removed melt settlement interest', { operationId });

    await this.removeRegisteredOperationInterest(operationId);
  }

  private async registerTrackedOperationInterests(): Promise<void> {
    for (const operation of this.interests.getAllOperations()) {
      if (!this.running) {
        return;
      }
      if (this.registeredOperationInterestIds.has(operation.id)) {
        continue;
      }
      await this.registerOperationWatchInterest(operation);
    }
  }

  private async registerOperationWatchInterest(
    operation: OperationQuoteInterest,
  ): Promise<boolean> {
    if (!this.interestRegistrar) {
      return true;
    }

    try {
      await this.interestRegistrar.registerOperationInterest({
        operationId: operation.id,
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
      });
      this.registeredOperationInterestIds.add(operation.id);
      return true;
    } catch (err) {
      this.logger?.warn('Failed to register melt quote operation watch interest', {
        operationId: operation.id,
        mintUrl: operation.mintUrl,
        method: operation.method,
        quoteId: operation.quoteId,
        err,
      });
      return false;
    }
  }

  private scheduleInitialOperationCheck(operationId: string, context: OperationCheckContext): void {
    if (this.scheduledInitialCheckOperationIds.has(operationId)) {
      return;
    }

    this.scheduledInitialCheckOperationIds.add(operationId);
    setTimeout(() => {
      this.scheduledInitialCheckOperationIds.delete(operationId);

      if (!this.running || !this.interests.has(operationId)) {
        return;
      }

      // Pending events are emitted before MeltOperationService releases its per-operation lock.
      void this.checkInterestedOperation(operationId, context);
    }, 0);
  }

  private async removeRegisteredOperationInterest(operationId: string): Promise<void> {
    const wasRegistered = this.registeredOperationInterestIds.delete(operationId);
    if (!wasRegistered) {
      return;
    }
    if (!this.interestRegistrar) {
      return;
    }

    await this.removeOperationWatchInterest(this.interestRegistrar, operationId);
  }

  private async removeOperationWatchInterest(
    registrar: OperationInterestRegistrar,
    operationId: string,
  ): Promise<void> {
    try {
      await registrar.removeOperationInterest(operationId);
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
    const context = {
      mintUrl: normalizeMintUrl(quote.mintUrl),
      method: quote.method,
      quoteId: quote.quoteId,
    };

    if (this.inFlightOperationIds.has(operationId)) {
      this.followUpCheckByOperationId.set(operationId, context);
      this.logger?.debug('Melt settlement check already in flight', {
        operationId,
        mintUrl: context.mintUrl,
        method: context.method,
        quoteId: context.quoteId,
      });
      return Promise.resolve();
    }

    const check = this.runOperationCheckLoop(operationId, context);

    this.inFlightChecks.add(check);
    check.finally(() => {
      this.inFlightChecks.delete(check);
    });
    return check;
  }

  private async runOperationCheckLoop(
    operationId: string,
    initialContext: OperationCheckContext,
  ): Promise<void> {
    this.inFlightOperationIds.add(operationId);
    let nextContext: OperationCheckContext | undefined = initialContext;

    try {
      while (nextContext) {
        const context = nextContext;
        nextContext = undefined;

        try {
          await this.meltOperations.checkPendingOperation(operationId);
        } catch (err) {
          this.logger?.warn('Failed to settle pending melt operation', {
            operationId,
            mintUrl: context.mintUrl,
            method: context.method,
            quoteId: context.quoteId,
            err,
          });
        }

        const followUpContext = this.followUpCheckByOperationId.get(operationId);
        if (followUpContext) {
          this.followUpCheckByOperationId.delete(operationId);
          nextContext = followUpContext;
        }
      }
    } finally {
      this.inFlightOperationIds.delete(operationId);
      this.followUpCheckByOperationId.delete(operationId);
    }
  }
}
