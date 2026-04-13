import type { MeltQuoteBolt11Response, MeltQuoteState, Token } from '@cashu/cashu-ts';
import type { HistoryRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type {
  HistoryEntry,
  MeltHistoryEntry,
  MintHistoryEntry,
  ReceiveHistoryEntry,
  ReceiveHistoryState,
  SendHistoryEntry,
  SendHistoryState,
} from '@core/models/History';
import type { PreparedOrLaterOperation } from '@core/operations/melt';
import type { PendingMintOperation } from '@core/operations/mint';
import type { MintQuoteState } from '@core/models/MintQuoteState';
import type { Logger } from '@core/logging';
import type { ReceiveOperation } from '@core/operations/receive/ReceiveOperation';
import type { SendOperation } from '@core/operations/send/SendOperation';

export class HistoryService {
  private readonly historyRepository: HistoryRepository;
  private readonly logger?: Logger;
  private readonly eventBus: EventBus<CoreEvents>;

  constructor(
    historyRepository: HistoryRepository,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.historyRepository = historyRepository;
    this.logger = logger;
    this.eventBus = eventBus;
    this.eventBus.on('mint-op:pending', ({ mintUrl, operation }) => {
      if (operation.state !== 'pending') return;
      return this.handleMintOperationPending(mintUrl, operation as PendingMintOperation);
    });
    this.eventBus.on('mint-op:quote-state-changed', ({ mintUrl, operationId, quoteId, state }) => {
      return this.handleMintOperationQuoteStateChanged(mintUrl, operationId, quoteId, state);
    });
    this.eventBus.on('melt-quote:created', ({ mintUrl, quoteId, quote }) => {
      return this.handleMeltQuoteCreated(mintUrl, quoteId, quote);
    });
    this.eventBus.on('melt-quote:state-changed', ({ mintUrl, quoteId, state }) => {
      return this.handleMeltQuoteStateChanged(mintUrl, quoteId, state);
    });
    this.eventBus.on('melt-op:prepared', ({ mintUrl, operation }) => {
      if (operation.state !== 'prepared') return;
      return this.handleMeltOperationUpdated(mintUrl, operation, 'UNPAID');
    });
    this.eventBus.on('melt-op:pending', ({ mintUrl, operation }) => {
      if (operation.state !== 'pending') return;
      return this.handleMeltOperationUpdated(mintUrl, operation, 'PENDING');
    });
    this.eventBus.on('melt-op:finalized', ({ mintUrl, operation }) => {
      if (operation.state !== 'finalized') return;
      return this.handleMeltOperationUpdated(mintUrl, operation, 'PAID');
    });
    this.eventBus.on('melt-op:rolled-back', ({ mintUrl, operation }) => {
      if (operation.state !== 'rolled_back') return;
      return this.handleMeltOperationRolledBack(mintUrl, operation);
    });
    this.eventBus.on('send:prepared', ({ mintUrl, operationId, operation }) => {
      return this.handleSendPrepared(mintUrl, operationId, operation);
    });
    this.eventBus.on('send:pending', ({ mintUrl, operationId, token }) => {
      return this.handleSendPending(mintUrl, operationId, token);
    });
    this.eventBus.on('send:finalized', ({ mintUrl, operationId }) => {
      return this.handleSendStateChanged(mintUrl, operationId, 'finalized');
    });
    this.eventBus.on('send:rolled-back', ({ mintUrl, operationId }) => {
      return this.handleSendStateChanged(mintUrl, operationId, 'rolledBack');
    });
    this.eventBus.on('receive-op:prepared', ({ mintUrl, operation }) => {
      if (operation.state !== 'prepared') return;
      return this.handleReceiveOperationUpdated(mintUrl, operation, 'prepared');
    });
    this.eventBus.on('receive-op:finalized', ({ mintUrl, operation }) => {
      if (operation.state !== 'finalized') return;
      return this.handleReceiveOperationUpdated(mintUrl, operation, 'finalized');
    });
    this.eventBus.on('receive-op:rolled-back', ({ mintUrl, operation }) => {
      if (operation.state !== 'rolled_back') return;
      return this.handleReceiveOperationUpdated(mintUrl, operation, 'rolledBack');
    });
    this.eventBus.on('receive:created', ({ mintUrl, token, operationId }) => {
      return this.handleReceiveCreated(mintUrl, token, operationId);
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
   * @throws Error if entry not found or is not a send entry
   */
  async getOperationIdFromHistoryEntry(historyId: string): Promise<string> {
    const entry = await this.historyRepository.getHistoryEntryById(historyId);

    if (!entry) {
      throw new Error(`History entry ${historyId} not found`);
    }

    if (entry.type !== 'send') {
      throw new Error(`History entry ${historyId} is not a send entry`);
    }

    return entry.operationId;
  }

  async handleSendPrepared(mintUrl: string, operationId: string, operation: SendOperation) {
    const entry: Omit<SendHistoryEntry, 'id'> = {
      type: 'send',
      createdAt: Date.now(),
      unit: 'sat', // TODO: get unit from operation/mint
      amount: operation.amount,
      mintUrl,
      operationId,
      state: 'prepared',
    };
    try {
      const entryRes = await this.historyRepository.addHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, entryRes);
    } catch (err) {
      this.logger?.error('Failed to add send prepared history entry', {
        mintUrl,
        operationId,
        err,
      });
    }
  }

  async handleSendPending(mintUrl: string, operationId: string, token: Token) {
    try {
      const entry = await this.historyRepository.getSendHistoryEntry(mintUrl, operationId);
      if (!entry) {
        this.logger?.error('Send pending history entry not found', {
          mintUrl,
          operationId,
        });
        return;
      }
      entry.state = 'pending';
      entry.token = token;
      entry.unit = token.unit || 'sat';
      await this.historyRepository.updateHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, entry);
    } catch (err) {
      this.logger?.error('Failed to update send pending history entry', {
        mintUrl,
        operationId,
        err,
      });
    }
  }

  async handleSendStateChanged(mintUrl: string, operationId: string, state: SendHistoryState) {
    try {
      await this.historyRepository.updateSendHistoryState(mintUrl, operationId, state);
      const entry = await this.historyRepository.getSendHistoryEntry(mintUrl, operationId);
      if (entry) {
        await this.handleHistoryUpdated(mintUrl, entry);
      }
    } catch (err) {
      this.logger?.error('Failed to update send state history entry', {
        mintUrl,
        operationId,
        state,
        err,
      });
    }
  }

  async handleReceiveCreated(mintUrl: string, token: Token, operationId?: string) {
    try {
      const amount = token.proofs.reduce((acc, proof) => acc + proof.amount, 0);
      if (operationId) {
        const existing = await this.historyRepository.getReceiveHistoryEntry(mintUrl, operationId);
        if (existing) {
          existing.amount = amount;
          existing.unit = token.unit || existing.unit || 'sat';
          existing.state = 'finalized';
          existing.token = token;
          await this.historyRepository.updateHistoryEntry(existing);
          await this.handleHistoryUpdated(mintUrl, existing);
          return;
        }
      }

      const entry: Omit<ReceiveHistoryEntry, 'id'> = {
        type: 'receive',
        createdAt: Date.now(),
        unit: token.unit || 'sat',
        amount,
        mintUrl,
        token,
        operationId,
        state: 'finalized',
      };
      const entryRes = await this.historyRepository.addHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, entryRes);
    } catch (err) {
      this.logger?.error('Failed to add receive created history entry', {
        mintUrl,
        token,
        err,
      });
    }
  }

  async handleReceiveOperationUpdated(
    mintUrl: string,
    operation: ReceiveOperation,
    state: ReceiveHistoryState,
  ) {
    try {
      const token =
        state === 'finalized'
          ? {
              mint: operation.mintUrl,
              proofs: operation.inputProofs,
              unit: operation.unit || 'sat',
            }
          : undefined;
      const existing = await this.historyRepository.getReceiveHistoryEntry(mintUrl, operation.id);
      if (existing) {
        existing.amount = operation.amount;
        existing.unit = operation.unit || existing.unit || 'sat';
        existing.state = state;
        if (token) {
          existing.token = token;
        }
        await this.historyRepository.updateHistoryEntry(existing);
        await this.handleHistoryUpdated(mintUrl, existing);
        return;
      }

      const entryPayload: Omit<ReceiveHistoryEntry, 'id'> = {
        type: 'receive',
        createdAt: Date.now(),
        unit: operation.unit || 'sat',
        amount: operation.amount,
        mintUrl,
        operationId: operation.id,
        state,
        token,
      };
      const entry = await this.historyRepository.addHistoryEntry(entryPayload);
      await this.handleHistoryUpdated(mintUrl, entry);
    } catch (err) {
      this.logger?.error('Failed to update receive history entry', {
        mintUrl,
        operationId: operation.id,
        state,
        err,
      });
    }
  }

  async handleMintOperationQuoteStateChanged(
    mintUrl: string,
    operationId: string,
    quoteId: string,
    state: MintQuoteState,
  ) {
    try {
      const entry = await this.historyRepository.getMintHistoryEntry(mintUrl, quoteId);
      if (!entry) {
        this.logger?.error('Mint operation quote state changed history entry not found', {
          mintUrl,
          quoteId,
          operationId,
        });
        return;
      }
      entry.operationId = operationId;
      entry.state = state;
      await this.historyRepository.updateHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, { ...entry, state });
    } catch (err) {
      this.logger?.error('Failed to update mint operation history state', {
        mintUrl,
        quoteId,
        operationId,
        err,
      });
    }
  }

  async handleMeltQuoteStateChanged(mintUrl: string, quoteId: string, state: MeltQuoteState) {
    try {
      const entry = await this.historyRepository.getMeltHistoryEntry(mintUrl, quoteId);
      if (!entry) {
        this.logger?.error('Melt quote state changed history entry not found', {
          mintUrl,
          quoteId,
        });
        return;
      }
      entry.state = state;
      await this.historyRepository.updateHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, { ...entry, state });
    } catch (err) {
      this.logger?.error('Failed to add melt quote state changed history entry', {
        mintUrl,
        quoteId,
        err,
      });
    }
  }

  async handleMeltQuoteCreated(mintUrl: string, quoteId: string, quote: MeltQuoteBolt11Response) {
    const entry: Omit<MeltHistoryEntry, 'id'> = {
      type: 'melt',
      createdAt: Date.now(),
      unit: quote.unit,
      amount: quote.amount,
      mintUrl,
      quoteId,
      state: quote.state,
    };
    try {
      const newEntry = await this.historyRepository.addHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, newEntry);
    } catch (err) {
      this.logger?.error('Failed to add melt quote created history entry', {
        mintUrl,
        quoteId,
        err,
      });
    }
  }

  async handleMeltOperationUpdated(
    mintUrl: string,
    operation: PreparedOrLaterOperation,
    state: MeltQuoteState,
  ) {
    const existing = await this.historyRepository.getMeltHistoryEntry(mintUrl, operation.quoteId);
    const entry: Omit<MeltHistoryEntry, 'id'> = {
      type: 'melt',
      mintUrl,
      operationId: operation.id,
      quoteId: operation.quoteId,
      amount: operation.amount,
      state,
      createdAt: operation.createdAt,
      unit: operation.unit || existing?.unit || 'sat',
    };

    try {
      if (existing) {
        existing.amount = entry.amount;
        existing.operationId = entry.operationId;
        existing.state = entry.state;
        existing.unit = entry.unit;
        const updated = await this.historyRepository.updateHistoryEntry(existing);
        await this.handleHistoryUpdated(mintUrl, updated);
        return;
      }

      const created = await this.historyRepository.addHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, created);
    } catch (err) {
      this.logger?.error('Failed to upsert melt operation history entry', {
        mintUrl,
        quoteId: operation.quoteId,
        operationId: operation.id,
        state,
        err,
      });
    }
  }

  async handleMeltOperationRolledBack(mintUrl: string, operation: PreparedOrLaterOperation) {
    await this.handleMeltOperationUpdated(mintUrl, operation, 'UNPAID');
  }

  async handleMintOperationPending(mintUrl: string, operation: PendingMintOperation) {
    const entry: Omit<MintHistoryEntry, 'id'> = {
      type: 'mint',
      mintUrl,
      operationId: operation.id,
      unit: operation.unit,
      paymentRequest: operation.request,
      quoteId: operation.quoteId,
      state: operation.lastObservedRemoteState ?? 'UNPAID',
      createdAt: operation.createdAt,
      amount: operation.amount,
    };

    try {
      const existing = await this.historyRepository.getMintHistoryEntry(mintUrl, operation.quoteId);
      if (existing) {
        existing.operationId = entry.operationId;
        existing.unit = entry.unit;
        existing.paymentRequest = entry.paymentRequest;
        existing.state = entry.state;
        existing.amount = entry.amount;
        const updated = await this.historyRepository.updateHistoryEntry(existing);
        await this.handleHistoryUpdated(mintUrl, updated);
        return;
      }

      const created = await this.historyRepository.addHistoryEntry(entry);
      await this.handleHistoryUpdated(mintUrl, created);
      this.logger?.debug('Added history entry for pending mint operation', {
        mintUrl,
        quoteId: operation.quoteId,
        operationId: operation.id,
        state: entry.state,
      });
    } catch (err) {
      this.logger?.error('Failed to add pending mint operation history entry', {
        mintUrl,
        quoteId: operation.quoteId,
        operationId: operation.id,
        err,
      });
    }
  }

  async handleHistoryUpdated(mintUrl: string, entry: HistoryEntry) {
    try {
      // Emit a shallow copy to prevent mutation after emission
      await this.eventBus.emit('history:updated', { mintUrl, entry: { ...entry } });
    } catch (err) {
      this.logger?.error('Failed to emit history entry', { mintUrl, entry, err });
    }
  }
}
