import type { HistoryProjectionRepository, MintQuoteRepository } from '..';
import type {
  HistoryEntry,
  HistoryType,
  LegacyHistoryEntry,
  LegacyHistoryRowInput,
  ReceiveHistoryEntry,
  SendHistoryEntry,
} from '@core/models/History';
import {
  compareHistoryEntries,
  parseHistoryEntryId,
  projectLegacyHistoryRow,
  projectMeltOperation,
  projectMintOperation,
  projectReceiveOperation,
  projectSendOperation,
} from '@core/models/History';
import { getMintQuoteRemoteState } from '@core/models/MintQuote';
import { toMintOperation, type MintOperationRecord } from '@core/operations/mint';
import type { MemoryMeltOperationRepository } from './MemoryMeltOperationRepository';
import type { MemoryMintOperationRepository } from './MemoryMintOperationRepository';
import type { MemoryReceiveOperationRepository } from './MemoryReceiveOperationRepository';
import type { MemorySendOperationRepository } from './MemorySendOperationRepository';

type OperationRepositories = {
  sendOperationRepository?: MemorySendOperationRepository;
  meltOperationRepository?: MemoryMeltOperationRepository;
  mintOperationRepository?: MemoryMintOperationRepository;
  mintQuoteRepository?: MintQuoteRepository;
  receiveOperationRepository?: MemoryReceiveOperationRepository;
};

export class MemoryHistoryRepository implements HistoryProjectionRepository {
  private readonly legacyEntries: LegacyHistoryEntry[] = [];

  constructor(private readonly operationRepositories: OperationRepositories = {}) {}

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const entries = await this.getProjectedEntries();
    return entries.slice(offset, offset + limit);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    const parsed = parseHistoryEntryId(id);
    if (!parsed) return null;

    if (parsed.source === 'legacy') {
      const entries = await this.getProjectedEntries();
      return entries.find((entry) => entry.id === id && entry.source === 'legacy') ?? null;
    }

    return this.projectOperationById(parsed.type, parsed.operationId);
  }

  async addLegacyHistoryEntry(history: LegacyHistoryRowInput): Promise<LegacyHistoryEntry> {
    const entry = projectLegacyHistoryRow(history);
    this.legacyEntries.push(entry);
    return entry;
  }

  async getSendHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<SendHistoryEntry | null> {
    const operation =
      await this.operationRepositories.sendOperationRepository?.getById(operationId);
    if (!operation || operation.mintUrl !== mintUrl) return null;
    return projectSendOperation(operation);
  }

  async getReceiveHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<ReceiveHistoryEntry | null> {
    const operation =
      await this.operationRepositories.receiveOperationRepository?.getById(operationId);
    if (!operation || operation.mintUrl !== mintUrl) return null;
    return projectReceiveOperation(operation);
  }

  private async getProjectedEntries(): Promise<HistoryEntry[]> {
    const operationEntries = await this.getOperationEntries();
    const dedupedLegacyEntries = this.dedupeLegacyEntries(operationEntries);

    return [...operationEntries, ...dedupedLegacyEntries].sort(compareHistoryEntries);
  }

  private async getOperationEntries(): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];

    const sendOperations = await this.operationRepositories.sendOperationRepository?.getAll();
    for (const operation of sendOperations ?? []) {
      const entry = projectSendOperation(operation);
      if (entry) entries.push(entry);
    }

    const meltOperations = await this.operationRepositories.meltOperationRepository?.getAll();
    for (const operation of meltOperations ?? []) {
      const entry = projectMeltOperation(operation);
      if (entry) entries.push(entry);
    }

    const mintOperations = await this.operationRepositories.mintOperationRepository?.getAll();
    for (const operation of mintOperations ?? []) {
      const entry = await this.projectMintOperation(operation);
      if (entry) entries.push(entry);
    }

    const receiveOperations = await this.operationRepositories.receiveOperationRepository?.getAll();
    for (const operation of receiveOperations ?? []) {
      const entry = projectReceiveOperation(operation);
      if (entry) entries.push(entry);
    }

    return entries;
  }

  private async projectOperationById(
    type: HistoryType,
    operationId: string,
  ): Promise<HistoryEntry | null> {
    switch (type) {
      case 'send': {
        const operation =
          await this.operationRepositories.sendOperationRepository?.getById(operationId);
        return operation ? projectSendOperation(operation) : null;
      }
      case 'melt': {
        const operation =
          await this.operationRepositories.meltOperationRepository?.getById(operationId);
        return operation ? projectMeltOperation(operation) : null;
      }
      case 'mint': {
        const operation =
          await this.operationRepositories.mintOperationRepository?.getById(operationId);
        return operation ? this.projectMintOperation(operation) : null;
      }
      case 'receive': {
        const operation =
          await this.operationRepositories.receiveOperationRepository?.getById(operationId);
        return operation ? projectReceiveOperation(operation) : null;
      }
    }
  }

  private async projectMintOperation(record: MintOperationRecord): Promise<HistoryEntry | null> {
    const operation = toMintOperation(record);
    const entry = projectMintOperation(operation);
    if (!entry) return null;

    const quote = await this.operationRepositories.mintQuoteRepository?.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    const remoteState = quote ? getMintQuoteRemoteState(quote) : undefined;

    return remoteState ? { ...entry, remoteState } : entry;
  }

  private dedupeLegacyEntries(operationEntries: HistoryEntry[]): LegacyHistoryEntry[] {
    const operationKeys = new Set<string>();
    const quoteKeys = new Set<string>();

    for (const entry of operationEntries) {
      if (entry.source !== 'operation') continue;
      operationKeys.add(this.operationKey(entry.type, entry.operationId));
      if ((entry.type === 'mint' || entry.type === 'melt') && entry.quoteId) {
        quoteKeys.add(this.quoteKey(entry.type, entry.mintUrl, entry.quoteId));
      }
    }

    return this.legacyEntries.filter((entry) => {
      if (
        entry.operationId &&
        operationKeys.has(this.operationKey(entry.type, entry.operationId))
      ) {
        return false;
      }

      if (
        (entry.type === 'mint' || entry.type === 'melt') &&
        entry.quoteId &&
        quoteKeys.has(this.quoteKey(entry.type, entry.mintUrl, entry.quoteId))
      ) {
        return false;
      }

      return true;
    });
  }

  private operationKey(type: HistoryType, operationId: string): string {
    return `${type}:${operationId}`;
  }

  private quoteKey(type: 'mint' | 'melt', mintUrl: string, quoteId: string): string {
    return `${type}:${mintUrl}:${quoteId}`;
  }
}
