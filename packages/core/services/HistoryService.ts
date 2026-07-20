import type { HistoryProjectionRepository, MintSwapOperationRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type {
  HistoryFilter,
  HistoryEntry,
  MintSwapHistoryEntry,
  OperationHistoryEntry,
} from '@core/models/History';
import {
  projectMeltOperation,
  projectMintOperation,
  projectMintSwapOperation,
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

    const emitMintSwap = async ({ operationId }: { operationId: string }) => {
      const operation = await this.mintSwapRepository?.getById(operationId);
      if (!operation) return;
      await this.eventBus.emit('history:updated', {
        mintUrl: operation.sourceMintUrl,
        entry: projectMintSwapOperation(operation),
      });
    };
    this.eventBus.on('mint-swap-op:prepared', emitMintSwap);
    this.eventBus.on('mint-swap-op:source-inflight', emitMintSwap);
    this.eventBus.on('mint-swap-op:destination-funded', emitMintSwap);
    this.eventBus.on('mint-swap-op:issuing', emitMintSwap);
    this.eventBus.on('mint-swap-op:completed', emitMintSwap);
    this.eventBus.on('mint-swap-op:cancelled', emitMintSwap);
    this.eventBus.on('mint-swap-op:failed', emitMintSwap);
    this.eventBus.on('mint-swap-op:needs-attention', emitMintSwap);
  }

  async getPaginatedHistory(
    offset = 0,
    limit = 25,
    filter: HistoryFilter = {},
  ): Promise<HistoryEntry[]> {
    if (!this.mintSwapRepository) {
      if (!filter.mintUrl && !filter.types) {
        return this.historyRepository.getPaginatedHistoryEntries(limit, offset);
      }
      const entries = await this.historyRepository.getPaginatedHistoryEntries(10_000, 0);
      return entries
        .filter((entry) => matchesHistoryFilter(entry, filter))
        .slice(offset, offset + limit);
    }
    const [children, parents] = await Promise.all([
      this.historyRepository.getPaginatedHistoryEntries(10_000, 0),
      this.getMintSwapHistory(),
    ]);
    const visibleChildren: HistoryEntry[] = [];
    for (const entry of children) {
      if (
        entry.source === 'operation' &&
        entry.type === 'mint' &&
        (await this.mintSwapRepository.getByDestinationMintOperationId(entry.operationId))
      ) {
        continue;
      }
      if (
        entry.source === 'operation' &&
        entry.type === 'melt' &&
        (await this.mintSwapRepository.getBySourceMeltOperationId(entry.operationId))
      ) {
        continue;
      }
      visibleChildren.push(entry);
    }
    return [...visibleChildren, ...parents]
      .filter((entry) => matchesHistoryFilter(entry, filter))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
      .slice(offset, offset + limit);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    if (id.startsWith('mint-swap:') && this.mintSwapRepository) {
      const operation = await this.mintSwapRepository.getById(id.slice('mint-swap:'.length));
      return operation ? projectMintSwapOperation(operation) : null;
    }
    return this.historyRepository.getHistoryEntryById(id);
  }

  private async getMintSwapHistory(): Promise<MintSwapHistoryEntry[]> {
    if (!this.mintSwapRepository) return [];
    const states = [
      'preparing',
      'prepared',
      'source_inflight',
      'destination_funded',
      'issuing',
      'completed',
      'cancelled',
      'failed',
      'needs_attention',
    ] as const;
    const operations = (
      await Promise.all(states.map((state) => this.mintSwapRepository!.getByState(state)))
    ).flat();
    return operations.map(projectMintSwapOperation);
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

function matchesHistoryFilter(entry: HistoryEntry, filter: HistoryFilter): boolean {
  if (filter.types && !filter.types.includes(entry.type)) return false;
  if (!filter.mintUrl) return true;
  if (entry.type === 'mint-swap') {
    return entry.sourceMintUrl === filter.mintUrl || entry.destinationMintUrl === filter.mintUrl;
  }
  return entry.mintUrl === filter.mintUrl;
}
