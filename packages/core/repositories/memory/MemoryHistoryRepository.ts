import type { HistoryRepository } from '..';
import type {
  HistoryEntry,
  MintHistoryEntry,
  MeltHistoryEntry,
  ReceiveHistoryEntry,
  SendHistoryEntry,
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

  async updateHistoryEntry(
    history:
      | Omit<MintHistoryEntry, 'id' | 'createdAt'>
      | Omit<MeltHistoryEntry, 'id' | 'createdAt'>,
  ): Promise<HistoryEntry> {
    const idx = this.entries.findIndex((e) => {
      if ((e.type === 'mint' || e.type === 'melt') && e.type === history.type) {
        return e.mintUrl === history.mintUrl && e.quoteId === history.quoteId;
      }
      return false;
    });
    if (idx === -1) throw new Error('History entry not found');
    const existing = this.entries[idx];
    const updated: HistoryEntry = { ...existing, ...history } as HistoryEntry;
    this.entries[idx] = updated;
    return updated;
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
