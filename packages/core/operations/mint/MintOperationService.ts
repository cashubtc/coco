import { OperationInProgressError } from '../../models/Error.ts';
import type { MintCommit } from './MintCommands.ts';
import { Amount } from '@cashu/cashu-ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import { mintQuoteToMethodSnapshot, type MintQuote } from '../../models/MintQuote.ts';
import { assessMintQuoteClaimability } from '../../models/MintQuoteClaimability.ts';
import type { MintQuoteRef } from '../../models/QuoteIdentity.ts';
import type {
  MintOperationQueries,
  MintProofQueries,
  MintRecoveryQueries,
} from '../../queries/MintOperationQueries.ts';
import type { MintTransactions } from '../../transactions/mint/MintTransactions.ts';
import { deserializeOutputData, generateSubId, normalizeMintUrl } from '../../utils.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import type { MintMethod, PendingMintCheckResult } from './MintMethodHandler.ts';
import type {
  ExecutingMintOperation,
  MintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
} from './MintOperation.ts';
import { isDefinitiveMintRejection, mintLocalFacts } from './MintReconciliation.ts';
import type { MintRecoveryRecord } from './MintRecovery.ts';
import type { MintRemote } from './MintRemote.ts';

export interface ClaimMintQuoteOptions {
  autoClaimRemaining?: boolean;
}
export interface MintQuoteAccess {
  requireMintQuoteRefForPrepare(ref: MintQuoteRef): Promise<MintQuote>;
  getMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote | null>;
  getPendingMintQuotes(): Promise<MintQuote[]>;
  refreshMintQuote(mintUrl: string, method: MintMethod, quoteId: string): Promise<MintQuote>;
}
export interface MintOperationDependencies {
  operations: MintOperationQueries;
  proofs: MintProofQueries;
  recovery: MintRecoveryQueries;
  quotes: MintQuoteAccess;
  remote: MintRemote;
  transactions: MintTransactions;
  events: Pick<EventBus<CoreEvents>, 'emit'>;
  logger?: Logger;
}

/** One standalone Mint coordinator for every built-in method. No repository mutation authority. */
export class MintOperationService {
  private readonly locks = new OperationIdLock();
  private recovering = false;
  constructor(private readonly deps: MintOperationDependencies) {}
  isOperationLocked(id: string) {
    return this.locks.isLocked(id);
  }
  isRecoveryInProgress() {
    return this.recovering;
  }
  getOperation(id: string) {
    return this.deps.operations.getById(id);
  }
  getInFlightOperations() {
    return this.deps.operations.getPending();
  }
  async getPendingOperations(): Promise<PendingMintOperation[]> {
    return (await this.deps.operations.getByState('pending')).filter(
      (op): op is PendingMintOperation => op.state === 'pending',
    );
  }
  getOperationsForQuote(mintUrl: string, method: MintMethod, quoteId: string) {
    return this.deps.operations.getByQuoteId(normalizeMintUrl(mintUrl), method, quoteId);
  }
  async listOperationsByQuote(mintUrl: string, quoteId: string) {
    return (await this.deps.operations.getByMintUrl(normalizeMintUrl(mintUrl)))
      .filter((op) => op.quoteId === quoteId)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
  async getOperationByQuote(mintUrl: string, method: MintMethod, quoteId: string) {
    const operations = (await this.getOperationsForQuote(mintUrl, method, quoteId)).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
    );
    return (
      operations.find((op) => op.state === 'finalized') ??
      operations.find((op) => op.state === 'failed') ??
      operations[0] ??
      null
    );
  }

  async prepare(ref: MintQuoteRef, requestedAmount: Amount) {
    const quote = await this.deps.quotes.requireMintQuoteRefForPrepare(ref);
    const amount = Amount.from(requestedAmount);
    if (amount.isZero()) throw new Error('Mint amount must be positive');
    const preflight = await this.deps.remote.preflight(quote, amount);
    const prepared = await this.deps.transactions.prepare({
      ...preflight,
      id: generateSubId(),
      quote,
      amount,
    });
    await this.emit('counter:updated', prepared.counter);
    await this.publish({ operation: prepared.operation, changed: true, proofs: [] });
    return prepared.operation;
  }

  private async acquire(id: string): Promise<() => void> {
    for (;;) {
      try {
        return await this.locks.acquire(id);
      } catch (error) {
        if (!(error instanceof OperationInProgressError)) throw error;
        await this.locks.waitForUnlock(id);
      }
    }
  }

  async execute(id: string): Promise<MintOperation> {
    const release = await this.acquire(id);
    try {
      const migrated = await this.deps.transactions.migrate(id);
      await this.publish(migrated);
      const operation = migrated.operation;
      if (operation.state === 'executing') return this.reconcile(operation);
      if (operation.state === 'finalized' || operation.state === 'failed') return operation;
      if (operation.state !== 'pending')
        throw new Error(`Cannot execute operation ${id} in state ${operation.state}`);
      const material = await this.deps.remote.prepareRequest(operation);
      const authorized = await this.deps.transactions.authorize({ operationId: id, ...material });
      await this.publish(authorized);
      // Only the caller that committed authorization may transmit. Other coordinators restore.
      if (!authorized.changed || !authorized.recovery || authorized.operation.state !== 'executing')
        return authorized.operation;
      return this.transmit(authorized.operation, authorized.recovery);
    } finally {
      release();
    }
  }

  private async transmit(
    operation: ExecutingMintOperation,
    recovery: MintRecoveryRecord,
  ): Promise<MintOperation> {
    try {
      const receipts = await this.deps.remote.issue(operation, recovery);
      const result = await this.deps.transactions.applyEvidence(operation.id, receipts);
      await this.publish(result);
      return result.operation;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isDefinitiveMintRejection(error)) {
        const useLegacy = Number((error as { code: unknown }).code) === 20008;
        const rejected = await this.deps.transactions.reject(
          operation.id,
          recovery.revision,
          message,
          useLegacy,
        );
        await this.publish(rejected);
        if (rejected.changed && rejected.operation.state === 'executing' && rejected.recovery)
          return this.transmit(rejected.operation, rejected.recovery);
        if (rejected.operation.state === 'failed') return rejected.operation;
      }
      await this.deps.transactions.noteAmbiguity(operation.id, recovery.revision, message);
      const reconciled = await this.reconcile(operation);
      if (reconciled.state === 'finalized') return reconciled;
      throw error;
    }
  }

  /** Bounded recovery: exact evidence first. Quote totals and empty Restore never cancel a request. */
  private async reconcile(operation: PendingOrLaterOperation): Promise<MintOperation> {
    let recovery = await this.deps.recovery.get(operation.id);
    if (!recovery) throw new Error('Mint recovery provenance is missing');
    const cached = await this.deps.proofs.getProofsByOperationId(operation.mintUrl, operation.id);
    const outputs = deserializeOutputData(operation.outputData).keep;
    const localReceipts = cached.flatMap((proof) => {
      if (proof.createdByOperationId !== operation.id || proof.unit !== operation.unit) return [];
      const output = outputs.find(
        (o) =>
          new TextDecoder().decode(o.secret) === proof.secret &&
          o.blindedMessage.id === proof.id &&
          o.blindedMessage.amount.equals(proof.amount),
      );
      if (!output) return [];
      const { mintUrl, unit, state, createdByOperationId, usedByOperationId, ...material } = proof;
      return [
        {
          B_: output.blindedMessage.B_,
          proof: { ...material, amount: proof.amount.toString() },
          state: state === 'spent' ? ('SPENT' as const) : ('UNKNOWN' as const),
        },
      ];
    });
    if (localReceipts.length) {
      const saved = await this.deps.transactions.applyEvidence(operation.id, localReceipts);
      await this.publish(saved);
      recovery = saved.recovery ?? recovery;
      if (
        saved.operation.state === 'finalized' &&
        !recovery.receipts.some((r) => r.state === 'UNKNOWN' || r.state === 'PENDING')
      )
        return saved.operation;
    }
    if (recovery.receipts.length) {
      const checked = await this.deps.remote
        .checkReceipts(operation, recovery.receipts)
        .catch(() => recovery!.receipts);
      const local = await this.deps.transactions.applyEvidence(operation.id, checked);
      await this.publish(local);
      if (local.operation.state === 'finalized') return local.operation;
      recovery = local.recovery ?? recovery;
    }
    try {
      const receipts = await this.deps.remote.restore(operation);
      const result = await this.deps.transactions.applyEvidence(operation.id, receipts);
      await this.publish(result);
      if (result.operation.state === 'finalized') return result.operation;
      recovery = result.recovery ?? recovery;
    } catch (error) {
      await this.deps.transactions.noteAmbiguity(
        operation.id,
        recovery.revision,
        `Restore unavailable or invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // Keep canonical accounting current for later independent claims; it cannot settle this one.
    try {
      await this.deps.quotes.refreshMintQuote(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
    } catch (error) {
      this.deps.logger?.debug('Mint quote observation unavailable during recovery', {
        operationId: operation.id,
      });
    }
    return (await this.getOperation(operation.id)) ?? operation;
  }

  async finalize(id: string) {
    return this.execute(id);
  }
  async recoverExecutingOperation(operation: ExecutingMintOperation): Promise<void> {
    await this.execute(operation.id);
  }

  async recoverPendingOperations(): Promise<void> {
    if (this.recovering) throw new Error('Recovery is already in progress');
    this.recovering = true;
    try {
      const operations = [
        ...(await this.deps.operations.getByState('init')),
        ...(await this.getInFlightOperations()),
      ];
      for (const operation of operations) {
        if (this.isOperationLocked(operation.id)) continue;
        try {
          if (operation.state === 'init') await this.deps.transactions.migrate(operation.id);
          else if (await this.deps.remote.isTrusted(operation.mintUrl)) {
            const migrated = await this.deps.transactions.migrate(operation.id);
            await this.publish(migrated);
            if (migrated.operation.state === 'pending')
              await this.checkPendingOperation(operation.id);
            else if (migrated.operation.state === 'executing') await this.execute(operation.id);
          }
        } catch (error) {
          this.deps.logger?.warn('Mint recovery remains unresolved', { operationId: operation.id });
        }
      }
      // Finalized issuance can still have proofs held until their spendability becomes known.
      for (const recovery of await this.deps.recovery.getAll()) {
        if (
          recovery.provenance !== 'settled' ||
          !recovery.receipts.some((r) => r.state === 'UNKNOWN' || r.state === 'PENDING')
        )
          continue;
        const operation = await this.getOperation(recovery.operationId);
        if (
          operation?.state === 'finalized' &&
          (await this.deps.remote.isTrusted(operation.mintUrl))
        ) {
          try {
            await this.reconcile(operation);
          } catch {
            /* retain durable holding area */
          }
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private async assess(
    quote: MintQuote,
    siblings: MintOperation[],
    options: { requestedAmount?: Amount; targetOperationId?: string } = {},
  ) {
    const records = new Map<string, MintRecoveryRecord>();
    for (const sibling of siblings) {
      const record = await this.deps.recovery.get(sibling.id);
      if (record) records.set(sibling.id, record);
    }
    return assessMintQuoteClaimability(quote, {
      ...mintLocalFacts(siblings, records, options.targetOperationId),
      requestedAmount: options.requestedAmount,
    });
  }
  async getMintQuoteClaimability(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    options: { requestedAmount?: Amount; targetOperationId?: string } = {},
  ) {
    const quote = await this.deps.quotes.getMintQuote(mintUrl, method, quoteId);
    return quote
      ? this.assess(quote, await this.getOperationsForQuote(mintUrl, method, quoteId), options)
      : undefined;
  }

  async claimMintQuote(
    mintUrl: string,
    method: MintMethod,
    quoteId: string,
    options: ClaimMintQuoteOptions = {},
  ): Promise<MintOperation[]> {
    // Reconcile older commitments before selecting any new amount.
    for (const sibling of await this.getOperationsForQuote(mintUrl, method, quoteId)) {
      const recovery = await this.deps.recovery.get(sibling.id);
      if (
        sibling.state === 'executing' ||
        (sibling.state === 'pending' && recovery?.provenance !== 'prepared')
      )
        await this.execute(sibling.id);
    }
    const claimed: MintOperation[] = [];
    for (const operation of await this.getOperationsForQuote(mintUrl, method, quoteId)) {
      if (operation.state !== 'pending') continue;
      const assessment = await this.getMintQuoteClaimability(mintUrl, method, quoteId, {
        requestedAmount: operation.amount,
        targetOperationId: operation.id,
      });
      if (assessment?.status === 'claimable') claimed.push(await this.execute(operation.id));
    }
    if (options.autoClaimRemaining ?? true) {
      const quote = await this.deps.quotes.getMintQuote(mintUrl, method, quoteId);
      if (!quote) throw new Error('Mint quote not found');
      const assessment = await this.getMintQuoteClaimability(mintUrl, method, quoteId);
      if (assessment?.status === 'claimable' && assessment.claimAmount) {
        const amount = await this.deps.remote.selectAmount(quote, assessment.claimAmount);
        if (!amount.isZero()) {
          const operation = await this.prepare(quote, amount);
          claimed.push(await this.execute(operation.id));
        }
      }
    }
    return claimed;
  }
  async claimPendingMintQuotes(options: ClaimMintQuoteOptions = {}) {
    const result: MintOperation[] = [];
    for (const quote of await this.deps.quotes.getPendingMintQuotes()) {
      if (await this.deps.remote.isTrusted(quote.mintUrl))
        result.push(
          ...(await this.claimMintQuote(quote.mintUrl, quote.method, quote.quoteId, options)),
        );
    }
    return result;
  }
  async observePendingOperation(id: string): Promise<PendingMintCheckResult> {
    const operation = await this.getOperation(id);
    if (!operation || operation.state !== 'pending')
      throw new Error(`Cannot check operation ${id}: expected pending`);
    const quote = await this.deps.quotes.refreshMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    const assessment = await this.getMintQuoteClaimability(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
      { requestedAmount: operation.amount, targetOperationId: operation.id },
    );
    return {
      category: assessment?.status === 'claimable' ? 'ready' : 'waiting',
      observedRemoteStateAt: Date.now(),
      quoteSnapshot: mintQuoteToMethodSnapshot(quote),
    };
  }
  async checkPendingOperation(id: string) {
    const result = await this.observePendingOperation(id);
    if (result.category === 'ready') await this.execute(id);
    return result;
  }
  private async emit<E extends keyof CoreEvents>(event: E, payload: CoreEvents[E]) {
    try {
      await this.deps.events.emit(event, payload);
    } catch {
      this.deps.logger?.warn('Mint event listener failed after commit', { event });
    }
  }
  private async publish(commit: MintCommit) {
    const { operation, changed, proofs } = commit;
    try {
      for (const keysetId of new Set(proofs.map((p) => p.id)))
        await this.emit('proofs:saved', {
          mintUrl: operation.mintUrl,
          keysetId,
          proofs: proofs.filter((p) => p.id === keysetId),
        });
      if (!changed || operation.state === 'init') return;
      const payload = { mintUrl: operation.mintUrl, operationId: operation.id, operation };
      switch (operation.state) {
        case 'pending':
          await this.emit('mint-op:pending', { ...payload, operation });
          break;
        case 'executing':
          await this.emit('mint-op:executing', { ...payload, operation });
          break;
        case 'finalized':
          await this.emit('mint-op:finalized', { ...payload, operation });
          break;
        case 'failed':
          await this.emit('mint-op:failed', { ...payload, operation });
          break;
      }
    } catch {
      this.deps.logger?.warn('Mint event listener failed after commit', {
        operationId: operation.id,
      });
    }
  }
}
