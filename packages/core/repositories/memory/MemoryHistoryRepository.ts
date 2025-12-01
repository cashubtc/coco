import type { HistoryRepository } from '..';
import type {
  HistoryEntry,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  SendHistoryEntry,
  SendHistoryState,
} from '@core/models/History';

type NewHistoryEntry =
  | Omit<MintHistoryEntry, 'id'>
  | Omit<MeltHistoryEntry, 'id'>
  | Omit<SendHistoryEntry, 'id'>
  | Omit<ReceiveHistoryEntry, 'id'>;

export class MemoryHistoryRepository implements HistoryRepository {
  private readonly entries: HistoryEntry[] = [];
  private nextId = 1;

  async getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]> {
    const sorted = [...this.entries].sort((a, b) => {
      if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
      return Number(b.id) - Number(a.id);
    });
    return sorted.slice(offset, offset + limit);
  }

  async addHistoryEntry(history: NewHistoryEntry): Promise<HistoryEntry> {
    const entry: HistoryEntry = { id: String(this.nextId++), ...history } as HistoryEntry;
    this.entries.push(entry);
    return entry;
  }

  async getMintHistoryEntry(mintUrl: string, quoteId: string): Promise<MintHistoryEntry | null> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e) continue;
      if (e.type === 'mint' && e.mintUrl === mintUrl && e.quoteId === quoteId) return e;
    }
    return null;
  }

  async getMeltHistoryEntry(mintUrl: string, quoteId: string): Promise<MeltHistoryEntry | null> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e) continue;
      if (e.type === 'melt' && e.mintUrl === mintUrl && e.quoteId === quoteId) return e;
    }
    return null;
  }

  async getSendHistoryEntry(
    mintUrl: string,
    operationId: string,
  ): Promise<SendHistoryEntry | null> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e) continue;
      if (e.type === 'send' && e.mintUrl === mintUrl && e.operationId === operationId) return e;
    }
    return null;
  }

  async updateHistoryEntry(
    history:
      | Omit<MintHistoryEntry, 'id' | 'createdAt'>
      | Omit<MeltHistoryEntry, 'id' | 'createdAt'>
      | Omit<SendHistoryEntry, 'id' | 'createdAt'>,
  ): Promise<HistoryEntry> {
    const idx = this.entries.findIndex((e) => {
      if (e.type === 'mint' && history.type === 'mint') {
        return e.mintUrl === history.mintUrl && e.quoteId === history.quoteId;
      }
      if (e.type === 'melt' && history.type === 'melt') {
        return e.mintUrl === history.mintUrl && e.quoteId === history.quoteId;
      }
      if (e.type === 'send' && history.type === 'send') {
        return e.mintUrl === history.mintUrl && e.operationId === history.operationId;
      }
      return false;
    });
    if (idx === -1) throw new Error('History entry not found');
    const existing = this.entries[idx];
    const updated: HistoryEntry = { ...existing, ...history } as HistoryEntry;
    this.entries[idx] = updated;
    return updated;
  }

  async updateSendHistoryState(
    mintUrl: string,
    operationId: string,
    state: SendHistoryState,
  ): Promise<void> {
    const entry = await this.getSendHistoryEntry(mintUrl, operationId);
    if (!entry) {
      throw new Error(`Send history entry not found for operationId: ${operationId}`);
    }
    entry.state = state;
  }

  async deleteHistoryEntry(mintUrl: string, quoteId: string): Promise<void> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      if (!e) continue;
      if (
        (e.type === 'mint' || e.type === 'melt') &&
        e.mintUrl === mintUrl &&
        e.quoteId === quoteId
      ) {
        this.entries.splice(i, 1);
      }
    }
  }
}
