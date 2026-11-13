import type { Token } from '@cashu/cashu-ts';
import type { Logger } from '@core/logging';
import type { HistoryEntry, OperationHistoryEntry } from '@core/models/History';
import {
  operationHistoryId,
  projectBatchMintOperation,
  projectMeltOperation,
  projectMintOperation,
  projectReceiveOperation,
  projectSendOperation,
} from '@core/models/History';
import type { BatchMintOperation } from '@core/operations/batchMint/BatchMintOperation';
import type { MeltOperation } from '@core/operations/melt';
import type { MintOperation } from '@core/operations/mint';
import type { MintSwapOperation } from '@core/operations/mintSwap/MintSwapOperation';
import type { MintSwapOperationRepository } from '@core/operations/mintSwap/MintSwapOperationRepository';
import type { ReceiveOperation } from '@core/operations/receive/ReceiveOperation';
import type { SendOperation } from '@core/operations/send/SendOperation';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { HistoryProjectionRepository } from '../repositories';

export class HistoryService {
  private readonly historyRepository: HistoryProjectionRepository;
  private readonly mintSwapOperationRepository: MintSwapOperationRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    historyRepository: HistoryProjectionRepository,
    mintSwapOperationRepository: MintSwapOperationRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.historyRepository = historyRepository;
    this.mintSwapOperationRepository = mintSwapOperationRepository;
    this.logger = logger;
    this.eventBus = eventBus;

    this.eventBus.on('send:prepared', ({ mintUrl, operation }) => {
      return this.emitProjectedSend(mintUrl, operation);
    });
    this.eventBus.on('send:pending', ({ mintUrl, operation, token }) => {
      return this.emitProjectedSend(mintUrl, this.withSendToken(operation, token));
    });
    this.eventBus.on('send:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedSend(mintUrl, operation);
    });
    this.eventBus.on('send:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedSend(mintUrl, operation);
    });

    this.eventBus.on('melt-op:prepared', ({ mintUrl, operation }) => {
      return this.emitProjectedMeltOrParent(mintUrl, operation);
    });
    this.eventBus.on('melt-op:pending', ({ mintUrl, operation }) => {
      return this.emitProjectedMeltOrParent(mintUrl, operation);
    });
    this.eventBus.on('melt-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedMeltOrParent(mintUrl, operation);
    });
    this.eventBus.on('melt-op:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedMeltOrParent(mintUrl, operation);
    });

    this.eventBus.on('mint-op:pending', ({ mintUrl, operation }) => {
      return this.emitProjectedMintOrParent(mintUrl, operation);
    });
    this.eventBus.on('mint-op:executing', ({ mintUrl, operation }) => {
      return this.emitProjectedMintOrParent(mintUrl, operation);
    });
    this.eventBus.on('mint-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedMintOrParent(mintUrl, operation);
    });
    this.eventBus.on('mint-op:failed', ({ mintUrl, operation }) => {
      return this.emitProjectedMintOrParent(mintUrl, operation);
    });

    // Each Batch Mint Member is its own mint history entry sharing the batch's outcome.
    this.eventBus.on('batch-mint-op:executing', ({ mintUrl, operation }) => {
      return this.emitProjectedBatchMint(mintUrl, operation);
    });
    this.eventBus.on('batch-mint-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedBatchMint(mintUrl, operation);
    });
    this.eventBus.on('batch-mint-op:failed', ({ mintUrl, operation }) => {
      return this.emitProjectedBatchMint(mintUrl, operation);
    });

    this.eventBus.on('receive-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });
    this.eventBus.on('receive-op:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });

    this.eventBus.on('mint-swap:updated', ({ operationId }) => {
      return this.emitMintSwapUpdate(operationId);
    });
  }

  async getPaginatedHistory(offset = 0, limit = 25): Promise<HistoryEntry[]> {
    return this.historyRepository.getPaginatedHistoryEntries(limit, offset);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    return this.historyRepository.getHistoryEntryById(id);
  }

  private async emitProjectedSend(mintUrl: string, operation: SendOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectSendOperation(operation), 'send', operation.id);
  }

  private async emitProjectedMelt(mintUrl: string, operation: MeltOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectMeltOperation(operation), 'melt', operation.id);
  }

  private async emitProjectedMeltOrParent(
    mintUrl: string,
    operation: MeltOperation,
  ): Promise<void> {
    const quote =
      operation.quoteId === undefined
        ? null
        : { mintUrl: operation.mintUrl, method: operation.method, quoteId: operation.quoteId };
    await this.emitChildOrParent('melt', operation.id, quote, () =>
      this.emitProjectedMelt(mintUrl, operation),
    );
  }

  private async emitProjectedMint(mintUrl: string, operation: MintOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectMintOperation(operation), 'mint', operation.id);
  }

  private async emitProjectedMintOrParent(
    mintUrl: string,
    operation: MintOperation,
  ): Promise<void> {
    const quote = {
      mintUrl: operation.mintUrl,
      method: operation.method,
      quoteId: operation.quoteId,
    };
    await this.emitChildOrParent('mint', operation.id, quote, () =>
      this.emitProjectedMint(mintUrl, operation),
    );
  }

  private async emitChildOrParent(
    role: 'mint' | 'melt',
    operationId: string,
    quote: Parameters<MintSwapOperationRepository['getByQuote']>[1] | null,
    emitChild: () => Promise<void>,
  ): Promise<void> {
    const parent = await this.findParentForChild(role, operationId, quote);
    if (parent === undefined) return;
    if (!parent) {
      await emitChild();
      return;
    }

    try {
      if (!(await this.emitMintSwapById(parent.id))) await emitChild();
    } catch (err) {
      this.logMintSwapProjectionFailure(operationId, err);
    }
  }

  /** A quote is the independent durable reverse key when the child-ID lookup is unavailable. */
  private async findParentForChild(
    role: 'mint' | 'melt',
    operationId: string,
    quote: Parameters<MintSwapOperationRepository['getByQuote']>[1] | null,
  ): Promise<MintSwapOperation | null | undefined> {
    try {
      return await this.mintSwapOperationRepository.getByChild(role, operationId);
    } catch (err) {
      this.logMintSwapProjectionFailure(operationId, err);
    }

    if (!quote) return undefined;
    try {
      return await this.mintSwapOperationRepository.getByQuote(role, quote);
    } catch (err) {
      this.logMintSwapProjectionFailure(operationId, err);
      return undefined;
    }
  }

  private async emitMintSwapUpdate(operationId: string): Promise<void> {
    try {
      await this.emitMintSwapById(operationId);
    } catch (err) {
      this.logMintSwapProjectionFailure(operationId, err);
    }
  }

  private async emitMintSwapById(operationId: string): Promise<boolean> {
    const entry = await this.historyRepository.getHistoryEntryById(
      operationHistoryId('mint-swap', operationId),
    );
    if (!entry) return false;
    if (entry.source !== 'operation' || entry.type !== 'mint-swap') {
      throw new Error(`Expected Mint Swap history entry for ${operationId}`);
    }
    await this.emitProjectedEntry(entry.mintUrl, entry, 'mint-swap', operationId);
    return true;
  }

  private logMintSwapProjectionFailure(operationId: string, err: unknown): void {
    this.logger?.error('Failed to emit Mint Swap history projection', {
      operationId,
      err,
    });
  }

  private async emitProjectedBatchMint(
    mintUrl: string,
    operation: BatchMintOperation,
  ): Promise<void> {
    for (const entry of projectBatchMintOperation(operation)) {
      await this.emitProjectedEntry(mintUrl, entry, 'mint', operation.id);
    }
  }

  private async emitProjectedReceive(mintUrl: string, operation: ReceiveOperation): Promise<void> {
    await this.emitProjectedEntry(
      mintUrl,
      projectReceiveOperation(operation),
      'receive',
      operation.id,
    );
  }

  private async emitProjectedEntry(
    mintUrl: string,
    entry: OperationHistoryEntry | null,
    type: OperationHistoryEntry['type'],
    operationId: string,
  ): Promise<void> {
    if (!entry) return;

    try {
      await this.eventBus.emit('history:updated', { mintUrl, entry: { ...entry } });
    } catch (err) {
      this.logger?.error('Failed to emit history projection', {
        mintUrl,
        type,
        operationId,
        err,
      });
    }
  }

  private withSendToken(operation: SendOperation, token: Token): SendOperation {
    if (operation.state === 'pending' || operation.state === 'finalized') {
      return { ...operation, token } as SendOperation;
    }
    return operation;
  }
}
