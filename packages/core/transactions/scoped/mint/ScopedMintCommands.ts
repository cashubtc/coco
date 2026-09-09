import type { ScopedOutputCommands } from '../outputs/ScopedOutputCommands.ts';
import { Amount } from '@cashu/cashu-ts';
import { ProofValidationError, UnknownMintError } from '../../../models/Error.ts';
import {
  applyBolt11MintQuoteStateFallback,
  getMintQuoteAmount,
  type MintQuote,
} from '../../../models/MintQuote.ts';
import { assessMintQuoteClaimability } from '../../../models/MintQuoteClaimability.ts';
import type {
  AuthorizeMintInput,
  FailMintInput,
  MintCommands,
  MintCommit,
  MintQuoteCommit,
  PreparedMintCommit,
  PrepareMintInput,
  ReturnMintToPendingInput,
  SettleMintInput,
} from '../../../operations/mint/MintCommands.ts';
import { mintLocalClaimabilityFacts } from '../../../operations/mint/MintLocalClaimability.ts';
import {
  getOutputProofSecrets,
  type MintOperation,
  type PendingMintOperation,
  type PendingOrLaterOperation,
} from '../../../operations/mint/MintOperation.ts';
import { resolveMintQuoteObservation } from '../../../quotes/MintQuoteObservation.ts';
import type { RepositoryTransactionScope } from '../../../repositories/index.ts';
import type { CoreProof } from '../../../types.ts';
import { deserializeOutputData, mapProofToCoreProof } from '../../../utils.ts';

export type ScopedMintCommands = MintCommands;

/** Existing Mint lifecycle mutations, using only repositories from one runner-owned scope. */
export class RepositoryMintCommands implements ScopedMintCommands {
  constructor(
    private readonly scope: RepositoryTransactionScope,
    private readonly outputs: ScopedOutputCommands,
  ) {}

  private async requireOperation(id: string) {
    const operation = await this.scope.mintOperationRepository.getById(id);
    if (!operation) throw new Error(`Operation ${id} not found`);
    return operation;
  }

  private unchanged(operation: MintOperation): MintCommit {
    return { operation, changed: false, proofs: [] };
  }

  private matches(current: MintOperation, expected: PendingOrLaterOperation) {
    return current.state === expected.state && current.updatedAt === expected.updatedAt;
  }

  private nextTimestamp(operation: MintOperation, timestamp: number) {
    return Math.max(timestamp, operation.updatedAt + 1);
  }

  async prepare(input: PrepareMintInput): Promise<PreparedMintCommit> {
    const { operation, activeKeys, seed } = input;
    const keysetId = activeKeys.id;
    const quote = await this.scope.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (!quote) throw new Error(`Mint quote ${operation.quoteId} was not found`);
    if (!(await this.scope.mintRepository.isTrustedMint(operation.mintUrl)))
      throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
    if (operation.amount.isZero())
      throw new ProofValidationError('Amount must be a positive number');
    if (
      quote.request !== operation.request ||
      quote.unit !== operation.unit ||
      quote.pubkey !== operation.pubkey
    )
      throw new Error('Mint quote changed during preparation');
    const assessment = assessMintQuoteClaimability(quote);
    if (assessment.status === 'complete' || assessment.status === 'invalid')
      throw new Error(`Cannot prepare mint quote ${quote.quoteId}: quote is ${assessment.status}`);
    const fixedAmount = getMintQuoteAmount(quote);
    if (fixedAmount) {
      if (!fixedAmount.equals(operation.amount))
        throw new Error(`Mint quote ${quote.quoteId} amount does not match requested amount`);
      const siblings = await this.scope.mintOperationRepository.getByQuoteId(
        quote.mintUrl,
        quote.method,
        quote.quoteId,
      );
      if (siblings.length)
        throw new Error(
          `Mint quote ${quote.quoteId} is already tracked by operation ${siblings[0]!.id} in state ${siblings[0]!.state}`,
        );
    }
    const allocated = await this.outputs.allocate({
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      activeKeys,
      seed,
      keepAmount: operation.amount,
      sendAmount: Amount.zero(),
    });
    const { outputData } = allocated;
    if (
      !outputData.keep.length ||
      outputData.send.length ||
      !Amount.sum(outputData.keep.map((output) => output.blindedMessage.amount)).equals(
        operation.amount,
      ) ||
      outputData.keep.some((output) => output.blindedMessage.id !== keysetId) ||
      new Set(outputData.keep.map((output) => output.blindedMessage.B_)).size !==
        outputData.keep.length ||
      new Set(outputData.keep.map((output) => output.secret)).size !== outputData.keep.length
    )
      throw new ProofValidationError('Invalid Mint output allocation');
    const pending: PendingMintOperation = { ...operation, outputData };
    await this.scope.mintOperationRepository.create(pending);
    return {
      operation: pending,
      counter: allocated.counter!,
    };
  }

  async authorize(input: AuthorizeMintInput): Promise<MintCommit> {
    const operation = await this.requireOperation(input.operationId);
    if (operation.state !== 'pending') return this.unchanged(operation);
    if (!(await this.scope.mintRepository.isTrustedMint(operation.mintUrl)))
      throw new UnknownMintError(`Mint ${operation.mintUrl} is not trusted`);
    const quote = await this.scope.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (quote) {
      const siblings = await this.scope.mintOperationRepository.getByQuoteId(
        operation.mintUrl,
        operation.method,
        operation.quoteId,
      );
      const assessment = assessMintQuoteClaimability(quote, {
        ...mintLocalClaimabilityFacts(siblings, operation.id),
        requestedAmount: operation.amount,
      });
      if (assessment.status === 'invalid')
        throw new Error(`Mint quote ${operation.quoteId} has invalid claimability accounting`);
      if (assessment.status === 'waiting') return this.unchanged(operation);
    }
    const executing = {
      ...operation,
      state: 'executing' as const,
      updatedAt: this.nextTimestamp(operation, input.timestamp),
      error: undefined,
    };
    await this.scope.mintOperationRepository.update(executing);
    return { operation: executing, changed: true, proofs: [] };
  }

  async settle(input: SettleMintInput): Promise<MintCommit> {
    const operation = await this.requireOperation(input.operation.id);
    if (operation.state === 'init') return this.unchanged(operation);
    const outputs = deserializeOutputData(operation.outputData);
    const expected = [...outputs.keep, ...outputs.send];
    const proofs: CoreProof[] = [];
    for (const proof of input.proofs) {
      if (
        !expected.some(
          (output) =>
            new TextDecoder().decode(output.secret) === proof.secret &&
            output.blindedMessage.id === proof.id &&
            output.blindedMessage.amount.equals(proof.amount),
        )
      )
        throw new ProofValidationError('Mint proof does not match persisted outputs');
      const existing = await this.scope.proofRepository.getProofBySecret(
        operation.mintUrl,
        proof.secret,
      );
      if (existing) {
        if (
          existing.id !== proof.id ||
          existing.C !== proof.C ||
          existing.unit !== operation.unit ||
          !existing.amount.equals(proof.amount) ||
          (existing.createdByOperationId && existing.createdByOperationId !== operation.id)
        )
          throw new ProofValidationError('Mint proof ownership conflict');
        continue;
      }
      if (!proofs.some((candidate) => candidate.secret === proof.secret))
        proofs.push(
          ...mapProofToCoreProof(operation.mintUrl, 'ready', [proof], {
            unit: operation.unit,
            createdByOperationId: operation.id,
          }),
        );
    }
    await this.scope.proofRepository.saveProofs(operation.mintUrl, proofs);
    // Positive proofs survive a concurrent recovery transition; stale lifecycle conclusions do not.
    if (operation.state !== 'executing' || !this.matches(operation, input.operation))
      return { operation, changed: false, proofs };
    const secrets = getOutputProofSecrets(operation);
    let complete = secrets.length > 0;
    for (const secret of secrets) {
      if (!(await this.scope.proofRepository.getProofBySecret(operation.mintUrl, secret)))
        complete = false;
    }
    // Keep the legacy distinction: an already-issued BOLT11 quote can finalize without proofs.
    // The dependent reconciliation change replaces this quote-wide conclusion with exact evidence.
    if (!complete && input.outcome === 'issued') return { operation, changed: false, proofs };
    const finalized = complete || input.outcome === 'already-issued';
    let quote: MintQuoteCommit | undefined;
    if (finalized && operation.method === 'bolt11') {
      const existing =
        (await this.scope.mintQuoteRepository.getMintQuote(
          operation.mintUrl,
          'bolt11',
          operation.quoteId,
        )) ?? this.legacyQuote(operation);
      if (existing.method !== 'bolt11') throw new Error('Mint quote method conflict');
      quote = await this.observeQuote(
        applyBolt11MintQuoteStateFallback(existing, 'ISSUED', input.timestamp),
      );
    }
    const updated = {
      ...operation,
      state: finalized ? ('finalized' as const) : ('pending' as const),
      updatedAt: this.nextTimestamp(operation, input.timestamp),
      error: complete
        ? undefined
        : `Recovered issued quote ${operation.quoteId} but no proofs could be restored`,
    };
    await this.scope.mintOperationRepository.update(updated);
    return { operation: updated, changed: true, proofs, quote };
  }

  private legacyQuote(operation: PendingOrLaterOperation): MintQuote<'bolt11'> {
    return {
      mintUrl: operation.mintUrl,
      method: 'bolt11',
      quoteId: operation.quoteId,
      quote: operation.quoteId,
      request: operation.request,
      unit: operation.unit,
      amount: operation.amount,
      expiry: operation.expiry,
      pubkey: operation.pubkey,
      state: 'UNPAID',
      reusable: false,
      amountPaid: Amount.zero(),
      amountIssued: Amount.zero(),
      remoteUpdatedAt: null,
      quoteData: { amount: operation.amount },
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    };
  }

  async returnToPending(input: ReturnMintToPendingInput): Promise<MintCommit> {
    const operation = await this.requireOperation(input.operation.id);
    if (operation.state !== 'executing' || !this.matches(operation, input.operation))
      return this.unchanged(operation);
    const pending = {
      ...operation,
      state: 'pending' as const,
      updatedAt: this.nextTimestamp(operation, input.timestamp),
      error: input.error,
    };
    await this.scope.mintOperationRepository.update(pending);
    return { operation: pending, changed: true, proofs: [] };
  }

  async fail(input: FailMintInput): Promise<MintCommit> {
    const operation = await this.requireOperation(input.operation.id);
    if (
      (operation.state !== 'pending' && operation.state !== 'executing') ||
      !this.matches(operation, input.operation)
    )
      return this.unchanged(operation);
    const failed = {
      ...operation,
      state: 'failed' as const,
      updatedAt: this.nextTimestamp(operation, input.timestamp),
      error: input.failure.reason,
      terminalFailure: input.failure,
    };
    await this.scope.mintOperationRepository.update(failed);
    return { operation: failed, changed: true, proofs: [] };
  }

  async observeQuote(incoming: MintQuote): Promise<MintQuoteCommit> {
    const existing = await this.scope.mintQuoteRepository.getMintQuote(
      incoming.mintUrl,
      incoming.method,
      incoming.quoteId,
    );
    const resolution = resolveMintQuoteObservation(existing, incoming);
    if (!resolution.disposition.startsWith('accepted-'))
      return { quote: resolution.resolvedQuote, changed: false };
    await this.scope.mintQuoteRepository.upsertMintQuote(resolution.resolvedQuote);
    return {
      quote: (await this.scope.mintQuoteRepository.getMintQuote(
        incoming.mintUrl,
        incoming.method,
        incoming.quoteId,
      ))!,
      changed: resolution.disposition === 'accepted-meaningful-change',
    };
  }

  async deleteInit(operationId: string): Promise<void> {
    const operation = await this.scope.mintOperationRepository.getById(operationId);
    if (operation?.state === 'init') await this.scope.mintOperationRepository.delete(operationId);
  }
}
