import {
  Amount,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { Logger } from '../../logging/Logger.ts';
import { MintIssuanceError } from '../../models/Error.ts';
import { getMintQuoteAmount, type MintQuote } from '../../models/MintQuote.ts';
import type { Repositories, RepositoryTransactionScope } from '../../repositories/index.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import {
  deserializeOutputData,
  generateSubId,
  mapProofToCoreProof,
  normalizeMintUrl,
  type SerializedOutputData,
} from '../../utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import type { MintIssuanceAttempt, PreparedMintIssuanceAttempt } from './MintIssuanceAttempt.ts';
import type {
  ExecutingMintOperation,
  FinalizedMintOperation,
  MintOperation,
  PendingMintOperation,
} from './MintOperation.ts';

const emptyOutputData = (): SerializedOutputData => ({ keep: [], send: [] });

/** Narrow transport seam for submitting a prepared BOLT11 issuance request. */
export interface MintIssuanceTransport {
  mintBolt11(
    mintUrl: string,
    quoteId: string,
    outputs: SerializedBlindedMessage[],
  ): Promise<SerializedBlindedSignature[]>;
}

interface MintIssuanceEngineOptions {
  repositories: Repositories;
  proofService: ProofService;
  walletService: WalletService;
  transport: MintIssuanceTransport;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

interface PreparedAttemptResult {
  attempt: PreparedMintIssuanceAttempt;
  operation: ExecutingMintOperation<'bolt11'>;
  keysetId: string;
  counterEnd: number;
}

interface FinalizedAttemptResult {
  operation: FinalizedMintOperation<'bolt11'>;
  quote: MintQuote<'bolt11'>;
  proofs: ReturnType<typeof mapProofToCoreProof>;
}

/**
 * Deep module for durable mint issuance and one-attempt Operation Recovery.
 * Callers provide candidates; the module owns selection, persistence, I/O, and finalization.
 */
export class MintIssuanceEngine {
  private readonly repositories: Repositories;
  private readonly proofService: ProofService;
  private readonly walletService: WalletService;
  private readonly transport: MintIssuanceTransport;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly mintScopedLock: MintScopedLock;

  constructor(options: MintIssuanceEngineOptions) {
    this.repositories = options.repositories;
    this.proofService = options.proofService;
    this.walletService = options.walletService;
    this.transport = options.transport;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.mintScopedLock = options.mintScopedLock ?? new MintScopedLock();
  }

  /**
   * Selects and issues at most one eligible operation from the supplied candidates.
   * Returns an empty list when none are eligible and owns persistence through finalization.
   */
  async issueCandidates(candidates: MintOperation[]): Promise<MintOperation[]> {
    for (const candidate of candidates) {
      const current = await this.repositories.mintOperationRepository.getById(candidate.id);
      if (!current || !(await this.isEligible(current))) continue;

      return this.runWithMintLock(current.mintUrl, async (events) => {
        const lockedCurrent = await this.repositories.mintOperationRepository.getById(current.id);
        if (!lockedCurrent) return [];
        if (lockedCurrent.state === 'finalized' || lockedCurrent.state === 'failed') {
          return [lockedCurrent];
        }
        if (!(await this.isEligible(lockedCurrent))) return [];

        const prepared = await this.prepareOne(lockedCurrent as PendingMintOperation<'bolt11'>);
        events.push(() =>
          this.eventBus.emit('counter:updated', {
            mintUrl: prepared.attempt.mintUrl,
            keysetId: prepared.keysetId,
            counter: prepared.counterEnd,
          }),
        );
        events.push(() =>
          this.eventBus.emit('mint-op:executing', {
            mintUrl: prepared.operation.mintUrl,
            operationId: prepared.operation.id,
            operation: prepared.operation,
          }),
        );
        const finalized = await this.dispatchPreparedAttempt(prepared.attempt);
        this.bufferFinalizedEvents(events, finalized);
        return [finalized.operation];
      });
    }

    return [];
  }

  /**
   * Resumes one prepared attempt through submission and finalization.
   * Submitted-attempt reconciliation is intentionally handled by the follow-up recovery slice.
   */
  async recoverAttempt(attempt: MintIssuanceAttempt | string): Promise<MintOperation[]> {
    const attemptId = typeof attempt === 'string' ? attempt : attempt.id;
    const current = await this.repositories.mintIssuanceAttemptRepository.getById(attemptId);
    if (!current) throw new MintIssuanceError(`Mint Issuance Attempt ${attemptId} not found`);
    if (current.state !== 'prepared') {
      throw new MintIssuanceError(
        `Mint Issuance Attempt ${attemptId} requires submitted-attempt recovery`,
      );
    }

    return this.runWithMintLock(current.mintUrl, async (events) => {
      const finalized = await this.dispatchPreparedAttempt(current);
      this.bufferFinalizedEvents(events, finalized);
      return [finalized.operation];
    });
  }

  private async runWithMintLock<T>(
    mintUrl: string,
    work: (events: Array<() => Promise<void>>) => Promise<T>,
  ): Promise<T> {
    const events: Array<() => Promise<void>> = [];
    const release = await this.mintScopedLock.acquire(normalizeMintUrl(mintUrl));
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await work(events);
    } catch (error) {
      failure = error;
    } finally {
      release();
    }

    for (const emit of events) {
      try {
        await emit();
      } catch (error) {
        this.logger?.warn('Mint issuance event listener failed', {
          mintUrl: normalizeMintUrl(mintUrl),
          error,
        });
      }
    }

    if (failure !== undefined) throw failure;
    return result as T;
  }

  private async isEligible(operation: MintOperation): Promise<boolean> {
    if (
      operation.state !== 'pending' ||
      operation.method !== 'bolt11' ||
      operation.mintIssuanceAttemptId ||
      !operation.amount.greaterThan(Amount.zero())
    ) {
      return false;
    }
    if (!(await this.repositories.mintRepository.isTrustedMint(operation.mintUrl))) return false;

    const quote = await this.repositories.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      'bolt11',
      operation.quoteId,
    );
    return this.matchesEligibleQuote(operation as PendingMintOperation<'bolt11'>, quote);
  }

  private matchesEligibleQuote(
    operation: PendingMintOperation<'bolt11'>,
    quote: MintQuote | null,
  ): quote is MintQuote<'bolt11'> {
    const fixedAmount = quote ? getMintQuoteAmount(quote) : undefined;
    return Boolean(
      quote &&
      quote.method === 'bolt11' &&
      !quote.reusable &&
      !quote.pubkey &&
      quote.state === 'PAID' &&
      fixedAmount &&
      fixedAmount.equals(operation.amount) &&
      quote.unit === operation.unit,
    );
  }

  private async prepareOne(
    candidate: PendingMintOperation<'bolt11'>,
  ): Promise<PreparedAttemptResult> {
    const mintUrl = normalizeMintUrl(candidate.mintUrl);
    const incomplete =
      await this.repositories.mintIssuanceAttemptRepository.listIncomplete(mintUrl);
    if (incomplete.length > 0) {
      throw new MintIssuanceError(
        `Mint ${mintUrl} already has incomplete Mint Issuance Attempt ${incomplete[0]!.id}`,
      );
    }

    const { keysetId } = await this.walletService.getWalletWithActiveKeysetId(
      mintUrl,
      candidate.unit,
    );
    const storedCounter = await this.repositories.counterRepository.getCounter(mintUrl, keysetId);
    const counterStart = storedCounter?.counter ?? 0;
    const outputs = await this.proofService.createMintOutputsAtCounter(
      mintUrl,
      { amount: candidate.amount, unit: candidate.unit },
      counterStart,
    );
    if (outputs.keysetId !== keysetId) {
      throw new MintIssuanceError(
        'Active keyset changed during Mint Issuance Attempt construction',
      );
    }

    const attemptId = generateSubId();
    return this.repositories.withTransaction(async (tx) => {
      const operation = await tx.mintOperationRepository.getById(candidate.id);
      if (!operation || operation.state !== 'pending' || operation.method !== 'bolt11') {
        throw new MintIssuanceError(
          `Mint Operation ${candidate.id} is no longer eligible for issuance`,
        );
      }
      if (operation.mintIssuanceAttemptId) {
        throw new MintIssuanceError(
          `Mint Operation ${candidate.id} is already attached to an attempt`,
        );
      }
      if (!(await tx.mintRepository.isTrustedMint(mintUrl))) {
        throw new MintIssuanceError(`Mint ${mintUrl} is no longer trusted`);
      }
      const quote = await tx.mintQuoteRepository.getMintQuote(mintUrl, 'bolt11', operation.quoteId);
      if (!this.matchesEligibleQuote(operation as PendingMintOperation<'bolt11'>, quote)) {
        throw new MintIssuanceError(
          `Mint Operation ${candidate.id} is no longer eligible for issuance`,
        );
      }
      const bolt11Operation = operation as PendingMintOperation<'bolt11'>;
      if ((await tx.mintIssuanceAttemptRepository.listIncomplete(mintUrl)).length > 0) {
        throw new MintIssuanceError(
          `Mint ${mintUrl} already has an incomplete Mint Issuance Attempt`,
        );
      }
      const counter = await tx.counterRepository.getCounter(mintUrl, keysetId);
      if ((counter?.counter ?? 0) !== counterStart) {
        throw new MintIssuanceError(
          'Deterministic counter changed before attempt creation committed',
        );
      }

      const createdAt = Date.now();
      const attempt: PreparedMintIssuanceAttempt = {
        id: attemptId,
        mintUrl,
        unit: operation.unit,
        state: 'prepared',
        members: [
          {
            operationId: bolt11Operation.id,
            quoteId: bolt11Operation.quoteId,
            amount: bolt11Operation.amount,
          },
        ],
        outputData: outputs.outputData,
        createdAt,
      };
      const executing: ExecutingMintOperation<'bolt11'> = {
        ...bolt11Operation,
        state: 'executing',
        mintIssuanceAttemptId: attempt.id,
        outputData: emptyOutputData(),
        error: undefined,
        updatedAt: createdAt,
      };
      await tx.mintIssuanceAttemptRepository.create(attempt);
      await tx.mintOperationRepository.update(executing);
      await tx.counterRepository.setCounter(mintUrl, keysetId, outputs.counterEnd);
      return {
        attempt,
        operation: executing,
        keysetId,
        counterEnd: outputs.counterEnd,
      };
    });
  }

  private async dispatchPreparedAttempt(
    attempt: PreparedMintIssuanceAttempt,
  ): Promise<FinalizedAttemptResult> {
    const member = attempt.members[0];
    if (!member || attempt.members.length !== 1) {
      throw new MintIssuanceError(
        `Mint Issuance Attempt ${attempt.id} is not a one-member attempt`,
      );
    }

    const submittedAt = Date.now();
    const submitted = await this.repositories.mintIssuanceAttemptRepository.compareAndTransition(
      attempt.id,
      { from: 'prepared', to: 'submitted', submittedAt },
    );
    if (!submitted) {
      throw new MintIssuanceError(`Mint Issuance Attempt ${attempt.id} is no longer prepared`);
    }

    const outputs = deserializeOutputData(attempt.outputData);
    if (outputs.send.length > 0 || outputs.keep.length === 0) {
      throw new MintIssuanceError(
        `Mint Issuance Attempt ${attempt.id} has invalid aggregate outputs`,
      );
    }
    const signatures = await this.transport.mintBolt11(
      attempt.mintUrl,
      member.quoteId,
      outputs.keep.map((output) => output.blindedMessage),
    );
    const proofs = await this.proofService.createProofsFromMintSignatures(
      attempt.mintUrl,
      attempt.outputData,
      signatures,
      attempt.unit,
    );
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', proofs, {
      unit: attempt.unit,
      createdByMintIssuanceAttemptId: attempt.id,
    });

    return this.repositories.withTransaction(async (tx) =>
      this.finalizeAttempt(tx, attempt, submittedAt, coreProofs),
    );
  }

  private async finalizeAttempt(
    tx: RepositoryTransactionScope,
    attempt: PreparedMintIssuanceAttempt,
    submittedAt: number,
    coreProofs: ReturnType<typeof mapProofToCoreProof>,
  ): Promise<FinalizedAttemptResult> {
    const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
    const member = attempt.members[0]!;
    const operation = await tx.mintOperationRepository.getById(member.operationId);
    if (currentAttempt?.state !== 'submitted') {
      throw new MintIssuanceError(`Mint Issuance Attempt ${attempt.id} is no longer submitted`);
    }
    if (
      !operation ||
      operation.state !== 'executing' ||
      operation.method !== 'bolt11' ||
      operation.mintIssuanceAttemptId !== attempt.id
    ) {
      throw new MintIssuanceError(`Mint Issuance Attempt ${attempt.id} no longer owns its member`);
    }
    const executing = operation as ExecutingMintOperation<'bolt11'>;

    await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
    await tx.mintQuoteRepository.setMintQuoteState(
      attempt.mintUrl,
      'bolt11',
      member.quoteId,
      'ISSUED',
      submittedAt,
    );
    const quote = await tx.mintQuoteRepository.getMintQuote(
      attempt.mintUrl,
      'bolt11',
      member.quoteId,
    );
    if (!quote || quote.method !== 'bolt11') {
      throw new MintIssuanceError(`Mint quote ${member.quoteId} disappeared during finalization`);
    }

    const finalized: FinalizedMintOperation<'bolt11'> = {
      ...executing,
      state: 'finalized',
      outputData: emptyOutputData(),
      error: undefined,
      updatedAt: Date.now(),
    };
    await tx.mintOperationRepository.update(finalized);
    const succeeded = await tx.mintIssuanceAttemptRepository.compareAndTransition(attempt.id, {
      from: 'submitted',
      to: 'succeeded',
    });
    if (!succeeded) {
      throw new MintIssuanceError(`Mint Issuance Attempt ${attempt.id} could not succeed`);
    }
    return { operation: finalized, quote, proofs: coreProofs };
  }

  private bufferFinalizedEvents(
    events: Array<() => Promise<void>>,
    finalized: FinalizedAttemptResult,
  ): void {
    for (const keysetId of new Set(finalized.proofs.map((proof) => proof.id))) {
      const proofs = finalized.proofs.filter((proof) => proof.id === keysetId);
      events.push(() =>
        this.eventBus.emit('proofs:saved', {
          mintUrl: finalized.operation.mintUrl,
          keysetId,
          proofs,
        }),
      );
    }
    events.push(() =>
      this.eventBus.emit('mint-quote:updated', {
        mintUrl: finalized.quote.mintUrl,
        method: 'bolt11',
        quoteId: finalized.quote.quoteId,
        quote: finalized.quote,
      }),
    );
    events.push(() =>
      this.eventBus.emit('mint-op:finalized', {
        mintUrl: finalized.operation.mintUrl,
        operationId: finalized.operation.id,
        operation: finalized.operation,
      }),
    );
  }
}
