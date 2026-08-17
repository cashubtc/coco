import type { HistoryProjectionRepository, MintSwapOperationRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { HistoryEntry, HistoryFilter, OperationHistoryEntry } from '@core/models/History';
import {
  compareHistoryEntries,
  projectMintSwapOperation,
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
import { normalizeMintUrl } from '@core/utils';

export class HistoryService {
  private readonly historyRepository: HistoryProjectionRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    historyRepository: HistoryProjectionRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
    private readonly mintSwapRepository?: MintSwapOperationRepository,
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
    this.eventBus.on('mint-op:failed', ({ mintUrl, operation }) => {
      return this.emitProjectedMint(mintUrl, operation);
    });

    this.eventBus.on('receive-op:finalized', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });
    this.eventBus.on('receive-op:rolled-back', ({ mintUrl, operation }) => {
      return this.emitProjectedReceive(mintUrl, operation);
    });

    const mintSwapEvents = [
      'mint-swap-op:prepared',
      'mint-swap-op:source-inflight',
      'mint-swap-op:destination-funded',
      'mint-swap-op:issuing',
      'mint-swap-op:completed',
      'mint-swap-op:cancelled',
      'mint-swap-op:failed',
      'mint-swap-op:needs-attention',
      'mint-swap-op:delayed',
    ] as const;
    for (const event of mintSwapEvents) {
      this.eventBus.on(event, ({ operationId }) => this.emitProjectedMintSwap(operationId));
    }
  }

  async getPaginatedHistory(
    offset = 0,
    limit = 25,
    filter: HistoryFilter = {},
  ): Promise<HistoryEntry[]> {
    if (limit <= 0) return [];
    const mintUrl = filter.mintUrl ? normalizeMintUrl(filter.mintUrl) : undefined;
    const pageWindow = offset + limit;
    const includeParents = !filter.types || filter.types.includes('mint-swap');
    const parents =
      this.mintSwapRepository && includeParents
        ? (await this.mintSwapRepository.getPaginated(pageWindow, 0, mintUrl)).map(
            projectMintSwapOperation,
          )
        : [];
    const ordinary = await this.getVisibleOrdinaryHistory(pageWindow, {
      ...filter,
      mintUrl,
    });
    return [...ordinary, ...parents].sort(compareHistoryEntries).slice(offset, pageWindow);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    if (id.startsWith('mint-swap:') && this.mintSwapRepository) {
      const operation = await this.mintSwapRepository.getById(id.slice('mint-swap:'.length));
      return operation ? projectMintSwapOperation(operation) : null;
    }
    return this.historyRepository.getHistoryEntryById(id);
  }

  private async getVisibleOrdinaryHistory(
    required: number,
    filter: HistoryFilter,
  ): Promise<HistoryEntry[]> {
    if (filter.types && !filter.types.some((type) => type !== 'mint-swap')) return [];
    const visible: HistoryEntry[] = [];
    const batchSize = Math.max(100, required);
    let offset = 0;
    while (visible.length < required) {
      const entries = await this.historyRepository.getPaginatedHistoryEntries(batchSize, offset);
      if (entries.length === 0) break;
      let candidates = entries.filter((entry) => this.matchesFilter(entry, filter));
      if (!filter.includeOwnedChildren && this.mintSwapRepository) {
        const childIds = candidates
          .filter(
            (entry): entry is OperationHistoryEntry =>
              entry.source === 'operation' && (entry.type === 'mint' || entry.type === 'melt'),
          )
          .map((entry) => entry.operationId);
        const owners = await this.mintSwapRepository.getByChildOperationIds(childIds);
        const owned = new Set(
          owners.flatMap((owner) =>
            [owner.destinationMintOperationId, owner.sourceMeltOperationId].filter(
              (id): id is string => id !== undefined,
            ),
          ),
        );
        candidates = candidates.filter(
          (entry) =>
            entry.source !== 'operation' ||
            (entry.type !== 'mint' && entry.type !== 'melt') ||
            !owned.has(entry.operationId),
        );
      }
      visible.push(...candidates);
      offset += entries.length;
      if (entries.length < batchSize) break;
    }
    return visible.slice(0, required);
  }

  private matchesFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
    if (entry.type === 'mint-swap') return false;
    if (filter.types && !filter.types.includes(entry.type)) return false;
    return !filter.mintUrl || entry.mintUrl === filter.mintUrl;
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

  private async emitProjectedMintSwap(operationId: string): Promise<void> {
    if (!this.mintSwapRepository) return;
    const operation = await this.mintSwapRepository.getById(operationId);
    if (!operation) return;
    const entry = projectMintSwapOperation(operation);
    try {
      await this.eventBus.emit('history:updated', {
        mintUrl: operation.destinationMintUrl,
        entry,
      });
    } catch (err) {
      this.logger?.error('Failed to emit Mint Swap history projection', { operationId, err });
    }
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
