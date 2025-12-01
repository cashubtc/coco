import type { HistoryEntry } from '@core/models/History';
import type { HistoryService } from '@core/services';

export class HistoryApi {
  private historyService: HistoryService;

  constructor(historyService: HistoryService) {
    this.historyService = historyService;
  }

  async getPaginatedHistory(offset = 0, limit = 25): Promise<HistoryEntry[]> {
    return this.historyService.getPaginatedHistory(offset, limit);
  }

  async getHistoryEntryById(id: string): Promise<HistoryEntry | null> {
    return this.historyService.getHistoryEntryById(id);
  }
}
