import type { Proof } from '@cashu/cashu-ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import type { MintAdapter } from '../../infra/MintAdapter.ts';
import type { Logger } from '../../logging/Logger.ts';
import { MintOperationError, UnknownMintError } from '../../models/Error.ts';
import {
  getMintQuoteAmount,
  getMintQuoteRemoteState,
  type MintQuote,
} from '../../models/MintQuote.ts';
import type { Repositories } from '../../repositories/index.ts';
import type { MintService } from '../../services/MintService.ts';
import type { ProofService } from '../../services/ProofService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import {
  deserializeOutputData,
  generateSubId,
  mapProofToCoreProof,
  normalizeMintUrl,
} from '../../utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import type { MintIssuanceAttempt } from './MintIssuanceAttempt.ts';
import type {
  ExecutingMintOperationRecord,
  FailedMintOperationRecord,
  FinalizedMintOperationRecord,
  MintOperation,
  MintOperationRecord,
  PendingMintOperationRecord,
} from './MintOperation.ts';
import { isTerminalOperation, toMintOperation } from './MintOperation.ts';

interface MintIssuanceCoordinatorOptions {
  repositories: Repositories;
  proofService: ProofService;
  mintService: MintService;
  walletService: WalletService;
  mintAdapter: MintAdapter;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  mintScopedLock?: MintScopedLock;
}

interface CreatedAttempt {
  attempt: MintIssuanceAttempt;
  operation: ExecutingMintOperationRecord<'bolt11'>;
}

const activeCoordinations = new WeakMap<Repositories, Map<string, Promise<MintOperation>>>();

function isTerminalAttempt(attempt: MintIssuanceAttempt): boolean {
  return (
    attempt.state === 'succeeded' || attempt.state === 'rejected' || attempt.state === 'failed'
  );
}

/**
 * Internal issuance boundary for durable single and future batched mint redemption.
 *
 * It intentionally depends only on lower-level services and repositories. Public APIs and the
 * background processor reach it through MintOperationService.
 */
export class MintIssuanceCoordinator {
  private readonly repositories: Repositories;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly mintAdapter: MintAdapter;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;
  private readonly mintScopedLock: MintScopedLock;
  private readonly scheduledOperationIds = new Set<string>();
  private readonly activeByOperationId: Map<string, Promise<MintOperation>>;

  constructor(options: MintIssuanceCoordinatorOptions) {
    this.repositories = options.repositories;
    const sharedActive = activeCoordinations.get(options.repositories) ?? new Map();
    activeCoordinations.set(options.repositories, sharedActive);
    this.activeByOperationId = sharedActive;
    this.proofService = options.proofService;
    this.mintService = options.mintService;
    this.walletService = options.walletService;
    this.mintAdapter = options.mintAdapter;
    this.eventBus = options.eventBus;
    this.logger = options.logger;
    this.mintScopedLock = options.mintScopedLock ?? new MintScopedLock();
  }

  schedule(operationId: string): void {
    this.scheduledOperationIds.add(operationId);
  }

  coordinate(): Promise<void>;
  coordinate(operationId: string): Promise<MintOperation>;
  coordinate(operationId?: string): Promise<void> | Promise<MintOperation> {
    if (operationId === undefined) {
      const next = this.scheduledOperationIds.values().next().value as string | undefined;
      if (!next) return Promise.resolve();
      this.scheduledOperationIds.delete(next);
      return (async () => {
        await this.coordinate(next);
      })();
    }

    const active = this.activeByOperationId.get(operationId);
    if (active) return active;

    const coordination = this.coordinateTarget(operationId).finally(() => {
      if (this.activeByOperationId.get(operationId) === coordination) {
        this.activeByOperationId.delete(operationId);
      }
    });
    this.activeByOperationId.set(operationId, coordination);
    return coordination;
  }

  isCoordinating(operationId: string): boolean {
    return this.activeByOperationId.has(operationId);
  }

  private async coordinateTarget(operationId: string): Promise<MintOperation> {
    let operation = await this.requireOperation(operationId);
    if (isTerminalOperation(operation)) return toMintOperation(operation);

    let attempt = operation.attemptId
      ? await this.repositories.mintIssuanceAttemptRepository.getById(operation.attemptId)
      : null;

    if (!attempt) {
      if (operation.state !== 'pending') {
        throw new Error(`Executing mint operation ${operation.id} is missing its issuance attempt`);
      }
      const created = await this.createSingleBolt11Attempt(operation);
      attempt = created.attempt;
      operation = created.operation;
    }

    if (!attempt.memberOperationIds.includes(operationId)) {
      throw new Error(
        `Mint issuance attempt ${attempt.id} does not contain operation ${operationId}`,
      );
    }

    switch (attempt.state) {
      case 'prepared':
        return this.dispatchSingleAttempt(attempt, operation);
      case 'submitting':
      case 'recovering':
        return this.reconcileSingleAttempt(attempt, operation);
      case 'succeeded': {
        const completed = await this.requireOperation(operationId);
        if (!isTerminalOperation(completed)) {
          throw new Error(
            `Succeeded attempt ${attempt.id} has non-terminal operation ${operationId}`,
          );
        }
        return toMintOperation(completed);
      }
      case 'rejected':
      case 'failed': {
        const completed = await this.requireOperation(operationId);
        if (isTerminalOperation(completed)) return toMintOperation(completed);
        throw new Error(`Terminal attempt ${attempt.id} has non-terminal operation ${operationId}`);
      }
    }
  }

  private async createSingleBolt11Attempt(
    candidate: PendingMintOperationRecord,
  ): Promise<CreatedAttempt> {
    if (candidate.method !== 'bolt11') {
      throw new Error(`Single issuance attempts currently support BOLT11, not ${candidate.method}`);
    }

    const mintUrl = normalizeMintUrl(candidate.mintUrl);
    const releaseMintLock = await this.mintScopedLock.acquire(mintUrl);
    try {
      const current = await this.requireOperation(candidate.id);
      if (current.attemptId) {
        const attempt = await this.repositories.mintIssuanceAttemptRepository.getById(
          current.attemptId,
        );
        if (!attempt || current.state !== 'executing' || current.method !== 'bolt11') {
          throw new Error(`Operation ${current.id} has an invalid issuance attempt attachment`);
        }
        return { attempt, operation: current as ExecutingMintOperationRecord<'bolt11'> };
      }
      if (current.state !== 'pending' || current.method !== 'bolt11') {
        throw new Error(
          `Cannot create BOLT11 issuance attempt for operation ${current.id} in state ${current.state}`,
        );
      }

      if (!(await this.mintService.isTrustedMint(mintUrl))) {
        throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
      }
      await this.mintService.assertMethodUnitSupported(mintUrl, 4, 'bolt11', {
        amount: current.amount,
        unit: current.unit,
      });
      const { keysetId } = await this.walletService.getWalletWithActiveKeysetId(
        mintUrl,
        current.unit,
      );
      const storedCounter = await this.repositories.counterRepository.getCounter(mintUrl, keysetId);
      const counterStart = storedCounter?.counter ?? 0;
      const outputs = await this.proofService.createMintOutputsAtCounter(
        mintUrl,
        { amount: current.amount, unit: current.unit },
        counterStart,
      );
      if (outputs.keysetId !== keysetId || outputs.counterStart !== counterStart) {
        throw new Error(
          'Active keyset or deterministic counter changed during attempt construction',
        );
      }
      const attemptId = generateSubId();
      const created = await this.repositories.withTransaction(async (tx) => {
        const operation = await tx.mintOperationRepository.getById(current.id);
        if (
          !operation ||
          operation.state !== 'pending' ||
          operation.method !== 'bolt11' ||
          operation.attemptId
        ) {
          throw new Error(`Mint operation ${current.id} is no longer eligible for issuance`);
        }
        if (!(await tx.mintRepository.isTrustedMint(mintUrl))) {
          throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
        }

        const quote = await tx.mintQuoteRepository.getMintQuote(
          mintUrl,
          'bolt11',
          operation.quoteId,
        );
        const bolt11Operation = operation as PendingMintOperationRecord<'bolt11'>;
        this.assertEligibleSingleQuote(bolt11Operation, quote);

        const transactionCounter = await tx.counterRepository.getCounter(mintUrl, keysetId);
        if ((transactionCounter?.counter ?? 0) !== counterStart) {
          throw new Error('Deterministic counter changed before attempt creation committed');
        }

        const now = Date.now();
        const amount = getMintQuoteAmount(quote!);
        if (!amount) throw new Error(`Mint quote ${bolt11Operation.quoteId} has no fixed amount`);
        const attempt: MintIssuanceAttempt = {
          id: attemptId,
          mintUrl,
          method: 'bolt11',
          unit: bolt11Operation.unit,
          keysetId,
          state: 'prepared',
          memberOperationIds: [bolt11Operation.id],
          quoteIds: [bolt11Operation.quoteId],
          quoteAmounts: [amount],
          signingRequirements: [null],
          outputData: outputs.outputData,
          counterStart,
          counterEnd: outputs.counterEnd,
          request: { kind: 'single', quoteId: bolt11Operation.quoteId },
          createdAt: now,
          updatedAt: now,
        };
        const executing: ExecutingMintOperationRecord<'bolt11'> = {
          ...bolt11Operation,
          state: 'executing',
          attemptId,
          outputData: outputs.outputData,
          error: undefined,
          updatedAt: now,
        };

        await tx.mintIssuanceAttemptRepository.create(attempt);
        await tx.mintOperationRepository.update(executing);
        await tx.counterRepository.setCounter(mintUrl, keysetId, outputs.counterEnd);
        return { attempt, operation: executing };
      });

      await this.eventBus.emit('counter:updated', {
        mintUrl,
        keysetId,
        counter: created.attempt.counterEnd,
      });
      await this.eventBus.emit('mint-op:executing', {
        mintUrl,
        operationId: created.operation.id,
        operation: toMintOperation(created.operation),
      });
      this.logger?.info('Mint issuance attempt prepared', {
        attemptId: created.attempt.id,
        memberOperationIds: created.attempt.memberOperationIds,
        mintUrl,
        method: 'bolt11',
        unit: created.attempt.unit,
      });
      return created;
    } finally {
      releaseMintLock();
    }
  }

  private assertEligibleSingleQuote(
    operation: PendingMintOperationRecord<'bolt11'>,
    quote: MintQuote | null,
  ): asserts quote is MintQuote<'bolt11'> {
    if (!quote || quote.method !== 'bolt11') {
      throw new Error(`Mint quote ${operation.quoteId} was not found for BOLT11 issuance`);
    }
    if (quote.reusable || getMintQuoteRemoteState(quote) !== 'PAID') {
      throw new Error(`Mint quote ${operation.quoteId} is not eligible for single issuance`);
    }
    const quoteAmount = getMintQuoteAmount(quote);
    if (!quoteAmount?.equals(operation.amount) || quote.unit !== operation.unit) {
      throw new Error(
        `Mint quote ${operation.quoteId} no longer matches operation ${operation.id}`,
      );
    }
  }

  private async dispatchSingleAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    if (operation.state !== 'executing' || operation.method !== 'bolt11') {
      throw new Error(`Attempt ${attempt.id} does not have one executing BOLT11 operation`);
    }
    const executing = operation as ExecutingMintOperationRecord<'bolt11'>;

    const submitting = await this.repositories.withTransaction(async (tx) => {
      const current = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!current) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      if (isTerminalAttempt(current)) return current;

      const now = Date.now();
      const updated: MintIssuanceAttempt = {
        ...current,
        state: 'submitting',
        submittedAt: current.submittedAt ?? now,
        updatedAt: now,
      };
      await tx.mintIssuanceAttemptRepository.update(updated);
      return updated;
    });
    if (isTerminalAttempt(submitting)) {
      return this.requireTerminalOperation(operation.id, submitting.id);
    }

    const outputData = deserializeOutputData(attempt.outputData);
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(
      attempt.mintUrl,
      attempt.unit,
    );
    try {
      const proofs = await wallet.mintProofsBolt11(
        executing.amount,
        executing.quoteId,
        { keysetId: attempt.keysetId },
        {
          type: 'custom',
          data: outputData.keep,
        },
      );
      this.assertExactProofSet(attempt, proofs);
      return await this.completeAttempt(attempt, executing, proofs, false);
    } catch (error) {
      const recovering = await this.markRecovering(submitting, error);
      if (isTerminalAttempt(recovering)) {
        return this.requireTerminalOperation(operation.id, recovering.id);
      }
      if (error instanceof MintOperationError && error.code === 20002) {
        return this.reconcileSingleAttempt(recovering, executing);
      }
      throw error;
    }
  }

  private async reconcileSingleAttempt(
    attempt: MintIssuanceAttempt,
    operation: MintOperationRecord,
  ): Promise<MintOperation> {
    if (operation.state !== 'executing' || operation.method !== 'bolt11') {
      throw new Error(`Attempt ${attempt.id} does not have one executing BOLT11 operation`);
    }
    const executing = operation as ExecutingMintOperationRecord<'bolt11'>;

    const recovering =
      attempt.state === 'recovering'
        ? attempt
        : await this.markRecovering(attempt, new Error('Recovery join started'));
    if (isTerminalAttempt(recovering)) {
      return this.requireTerminalOperation(operation.id, recovering.id);
    }
    let remoteQuote;
    try {
      remoteQuote = await this.mintAdapter.checkMintQuote(
        recovering.mintUrl,
        'bolt11',
        executing.quoteId,
      );
    } catch (error) {
      const latest = await this.markRecovering(recovering, error);
      if (isTerminalAttempt(latest)) {
        return this.requireTerminalOperation(operation.id, latest.id);
      }
      throw error;
    }
    if (remoteQuote.state === 'PAID') {
      return this.dispatchSingleAttempt(recovering, executing);
    }
    if (remoteQuote.state !== 'ISSUED') {
      const latest = await this.markRecovering(
        recovering,
        new Error(`Mint quote ${executing.quoteId} remains ${remoteQuote.state}`),
      );
      if (isTerminalAttempt(latest)) {
        return this.requireTerminalOperation(operation.id, latest.id);
      }
      throw new Error(
        `Cannot reconcile issuance attempt ${attempt.id}: quote is ${remoteQuote.state}`,
      );
    }

    const recovered = await this.proofService.recoverProofsFromOutputData(
      recovering.mintUrl,
      recovering.outputData,
      {
        unit: recovering.unit,
        createdByAttemptId: recovering.id,
        persistRecoveredProofs: false,
      },
    );
    try {
      this.assertExactProofSet(recovering, recovered);
    } catch {
      return this.failAttemptAsExternallyRedeemed(recovering, executing);
    }
    return this.completeAttempt(recovering, executing, recovered, true);
  }

  private assertExactProofSet(attempt: MintIssuanceAttempt, proofs: Proof[]): void {
    const outputData = deserializeOutputData(attempt.outputData);
    const expected = [...outputData.keep, ...outputData.send]
      .map((output) => ({
        secret: new TextDecoder().decode(output.secret),
        id: output.blindedMessage.id,
        amount: output.blindedMessage.amount,
      }))
      .sort((left, right) => left.secret.localeCompare(right.secret));
    const received = [...proofs].sort((left, right) => left.secret.localeCompare(right.secret));
    if (
      expected.length === 0 ||
      expected.length !== received.length ||
      new Set(received.map((proof) => proof.secret)).size !== received.length ||
      expected.some((output, index) => {
        const proof = received[index];
        return (
          !proof ||
          output.secret !== proof.secret ||
          output.id !== proof.id ||
          !output.amount.equals(proof.amount)
        );
      })
    ) {
      throw new Error(`Mint issuance attempt ${attempt.id} did not return its exact proof set`);
    }
  }

  private async completeAttempt(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord<'bolt11'>,
    proofs: Proof[],
    recovered: boolean,
  ): Promise<MintOperation> {
    const now = Date.now();
    const coreProofs = mapProofToCoreProof(attempt.mintUrl, 'ready', proofs, {
      unit: attempt.unit,
      createdByAttemptId: attempt.id,
    });
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation) {
        throw new Error(`Mint issuance attempt ${attempt.id} disappeared during reconciliation`);
      }
      if (currentOperation.state === 'finalized' && currentAttempt.state === 'succeeded') {
        return {
          operation: currentOperation as FinalizedMintOperationRecord<'bolt11'>,
          quote: await tx.mintQuoteRepository.getMintQuote(
            attempt.mintUrl,
            'bolt11',
            operation.quoteId,
          ),
          quoteChanged: false,
          committed: false,
        };
      }
      if (currentOperation.state !== 'executing' || currentOperation.attemptId !== attempt.id) {
        throw new Error(`Operation ${operation.id} no longer belongs to attempt ${attempt.id}`);
      }

      const quoteBefore = await tx.mintQuoteRepository.getMintQuote(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
      );
      if (!quoteBefore) {
        throw new Error(`Mint quote ${operation.quoteId} disappeared during reconciliation`);
      }
      await tx.proofRepository.saveProofs(attempt.mintUrl, coreProofs);
      await tx.mintQuoteRepository.setMintQuoteState(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
        'ISSUED',
        now,
      );
      const finalized: FinalizedMintOperationRecord<'bolt11'> = {
        ...currentOperation,
        method: 'bolt11',
        state: 'finalized',
        outputData: attempt.outputData,
        attemptId: attempt.id,
        error: undefined,
        updatedAt: now,
      };
      const succeeded: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'succeeded',
        updatedAt: now,
        recoveredAt: recovered ? now : currentAttempt.recoveredAt,
        terminalError: undefined,
      };
      await tx.mintOperationRepository.update(finalized);
      await tx.mintIssuanceAttemptRepository.update(succeeded);
      return {
        operation: finalized,
        quote: await tx.mintQuoteRepository.getMintQuote(
          attempt.mintUrl,
          'bolt11',
          operation.quoteId,
        ),
        quoteChanged: getMintQuoteRemoteState(quoteBefore) !== 'ISSUED',
        committed: true,
      };
    });

    if (!completed.committed) {
      return toMintOperation(completed.operation);
    }
    for (const keysetId of new Set(coreProofs.map((proof) => proof.id))) {
      await this.eventBus.emit('proofs:saved', {
        mintUrl: attempt.mintUrl,
        keysetId,
        proofs: coreProofs.filter((proof) => proof.id === keysetId),
      });
    }
    if (completed.quote && completed.quoteChanged) {
      await this.eventBus.emit('mint-quote:updated', {
        mintUrl: completed.quote.mintUrl,
        method: completed.quote.method,
        quoteId: completed.quote.quoteId,
        quote: completed.quote,
      });
    }
    await this.eventBus.emit('mint-op:finalized', {
      mintUrl: completed.operation.mintUrl,
      operationId: completed.operation.id,
      operation: toMintOperation(completed.operation),
    });
    this.logger?.info('Mint issuance attempt succeeded', {
      attemptId: attempt.id,
      memberOperationIds: attempt.memberOperationIds,
      mintUrl: attempt.mintUrl,
      method: attempt.method,
      unit: attempt.unit,
    });
    return toMintOperation(completed.operation);
  }

  private async failAttemptAsExternallyRedeemed(
    attempt: MintIssuanceAttempt,
    operation: ExecutingMintOperationRecord<'bolt11'>,
  ): Promise<MintOperation> {
    const now = Date.now();
    const error = `Mint quote ${operation.quoteId} was issued but its exact proofs could not be recovered`;
    const completed = await this.repositories.withTransaction(async (tx) => {
      const currentAttempt = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      const currentOperation = await tx.mintOperationRepository.getById(operation.id);
      if (!currentAttempt || !currentOperation || currentOperation.state !== 'executing') {
        throw new Error(`Cannot fail inconsistent mint issuance attempt ${attempt.id}`);
      }
      const quoteBefore = await tx.mintQuoteRepository.getMintQuote(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
      );
      if (!quoteBefore) {
        throw new Error(`Mint quote ${operation.quoteId} disappeared during reconciliation`);
      }
      await tx.mintQuoteRepository.setMintQuoteState(
        attempt.mintUrl,
        'bolt11',
        operation.quoteId,
        'ISSUED',
        now,
      );
      const failedOperation: FailedMintOperationRecord<'bolt11'> = {
        ...currentOperation,
        method: 'bolt11',
        state: 'failed',
        attemptId: attempt.id,
        outputData: attempt.outputData,
        error,
        terminalFailure: { reason: error, observedAt: now },
        updatedAt: now,
      };
      const failedAttempt: MintIssuanceAttempt = {
        ...currentAttempt,
        state: 'failed',
        updatedAt: now,
        terminalError: { message: error, code: 'EXACT_PROOFS_UNRECOVERABLE' },
      };
      await tx.mintOperationRepository.update(failedOperation);
      await tx.mintIssuanceAttemptRepository.update(failedAttempt);
      return {
        operation: failedOperation,
        quote: await tx.mintQuoteRepository.getMintQuote(
          attempt.mintUrl,
          'bolt11',
          operation.quoteId,
        ),
        quoteChanged: getMintQuoteRemoteState(quoteBefore) !== 'ISSUED',
      };
    });

    if (completed.quote && completed.quoteChanged) {
      await this.eventBus.emit('mint-quote:updated', {
        mintUrl: completed.quote.mintUrl,
        method: completed.quote.method,
        quoteId: completed.quote.quoteId,
        quote: completed.quote,
      });
    }
    await this.eventBus.emit('mint-op:failed', {
      mintUrl: completed.operation.mintUrl,
      operationId: completed.operation.id,
      operation: toMintOperation(completed.operation),
    });
    return toMintOperation(completed.operation);
  }

  private async markRecovering(
    attempt: MintIssuanceAttempt,
    error: unknown,
  ): Promise<MintIssuanceAttempt> {
    const recovering = await this.repositories.withTransaction(async (tx) => {
      const current = await tx.mintIssuanceAttemptRepository.getById(attempt.id);
      if (!current) throw new Error(`Mint issuance attempt ${attempt.id} no longer exists`);
      if (isTerminalAttempt(current)) return current;

      const now = Date.now();
      const updated: MintIssuanceAttempt = {
        ...current,
        state: 'recovering',
        recoveryStartedAt: current.recoveryStartedAt ?? now,
        updatedAt: now,
        terminalError: undefined,
      };
      await tx.mintIssuanceAttemptRepository.update(updated);
      return updated;
    });
    this.logger?.warn('Mint issuance attempt requires recovery', {
      attemptId: attempt.id,
      memberOperationIds: attempt.memberOperationIds,
      mintUrl: attempt.mintUrl,
      method: attempt.method,
      unit: attempt.unit,
      error: error instanceof Error ? error.message : String(error),
    });
    return recovering;
  }

  private async requireTerminalOperation(
    operationId: string,
    attemptId: string,
  ): Promise<MintOperation> {
    const operation = await this.requireOperation(operationId);
    if (!isTerminalOperation(operation)) {
      throw new Error(`Terminal attempt ${attemptId} has non-terminal operation ${operationId}`);
    }
    return toMintOperation(operation);
  }

  private async requireOperation(operationId: string): Promise<MintOperationRecord> {
    const operation = await this.repositories.mintOperationRepository.getById(operationId);
    if (!operation) throw new Error(`Operation ${operationId} not found`);
    return operation;
  }
}
