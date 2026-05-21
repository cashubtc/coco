import type { HistoryProjectionRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { HistoryEntry, OperationHistoryEntry } from '@core/models/History';
import {
  projectMeltOperation,
  projectMintOperation,
  projectReceiveOperation,
  projectSendOperation,
} from '@core/models/History';
import type { Logger } from '@core/logging';
import type { MeltOperation } from '@core/operations/melt';
import type { MintOperation } from '@core/operations/mint';
import type { ReceiveOperation } from '@core/operations/receive/ReceiveOperation';
import type { SendOperation } from '@core/operations/send/SendOperation';
import type { Token } from '@cashu/cashu-ts';

export class HistoryService {
  private readonly historyRepository: HistoryProjectionRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    historyRepository: HistoryProjectionRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.historyRepository = historyRepository;
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
      return this.emitProjectedMelt(mintUrl, operation);
    });
    this.eventBus.on('melt-op:pending', ({ mintUrl, operation }) => {
      return this.emitProjectedMelt(mintUrl, operation);
    });
    this.eventBus.on('melt-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedMelt(mintUrl, operation);
    });
    this.eventBus.on('melt-op:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedMelt(mintUrl, operation);
    });

    this.eventBus.on('mint-op:pending', ({ mintUrl, operation }) => {
      return this.emitProjectedMint(mintUrl, operation);
    });
    this.eventBus.on('mint-op:executing', ({ mintUrl, operation }) => {
      return this.emitProjectedMint(mintUrl, operation);
    });
    this.eventBus.on('mint-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedMint(mintUrl, operation);
    });

    this.eventBus.on('receive-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });
    this.eventBus.on('receive-op:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });
  }

  async getPaginatedHistory(offset = 0, limit = 25): Promise<HistoryEntry[]> {
    return this.historyRepository.getPaginatedHistoryEntries(limit, offset);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    return this.historyRepository.getHistoryEntryById(id);
  }

  /**
   * Get the operationId for a send history entry.
   * @throws Error if entry not found, is not a send entry, or has no operation id
   */
  async getOperationIdFromHistoryEntry(historyId: string): Promise<string> {
    const entry = await this.historyRepository.getHistoryEntryById(historyId);

    if (!entry) {
      throw new Error(`History entry ${historyId} not found`);
    }

    if (entry.type !== 'send') {
      throw new Error(`History entry ${historyId} is not a send entry`);
    }

    if (!entry.operationId) {
      throw new Error(`History entry ${historyId} is not backed by an operation`);
    }

    return entry.operationId;
  }

  private async emitProjectedSend(mintUrl: string, operation: SendOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectSendOperation(operation), 'send', operation.id);
  }

  private async emitProjectedMelt(mintUrl: string, operation: MeltOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectMeltOperation(operation), 'melt', operation.id);
  }

  private async emitProjectedMint(mintUrl: string, operation: MintOperation): Promise<void> {
    await this.emitProjectedEntry(mintUrl, projectMintOperation(operation), 'mint', operation.id);
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
