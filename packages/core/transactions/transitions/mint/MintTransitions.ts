import { Amount } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import { MintQuoteKeyError, ProofValidationError } from '@core/models/Error.ts';
import { getMintQuoteAmount } from '@core/models/MintQuote.ts';
import { assessMintQuoteClaimability } from '@core/models/MintQuoteClaimability.ts';
import {
  getOutputProofSecrets,
  isTerminalOperation,
  type ExecutingMintOperation,
  type FailedMintOperation,
  type FinalizedMintOperation,
  type MintOperation,
  type PendingMintOperation,
  type PendingOrLaterOperation,
} from '@core/operations/mint/MintOperation.ts';
import { assertOutputProofs } from '@core/proofs/OutputProofs.ts';
import { mapProofToCoreProof, normalizeMintUrl } from '@core/utils.ts';
import type { CoreProof } from '@core/types.ts';
import type { CoreTransaction } from '../../CoreTransaction.ts';
import { trackTransactionWork } from '../../TransactionLifetime.ts';
import type {
  ApplyMintResultInput,
  ApplyMintResult,
  PrepareMintResult,
  BeginMintExecutionResult,
  FailMintResult,
  DeferMintRecoveryInput,
  BeginMintExecutionInput,
  FailMintInput,
  PrepareMintInput,
} from './MintTransitionTypes.ts';

/** Persist the complete output plan and its counter allocation in the caller's transaction. */
export function prepareMint(
  tx: CoreTransaction,
  input: PrepareMintInput,
): Promise<PrepareMintResult> {
  return trackTransactionWork(tx, async () => {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const unit = normalizeUnit(input.unit);
    await tx.mintMetadata.assertCanMint(mintUrl, input.method, unit, input.amount);
    if (input.amount.isZero()) throw new ProofValidationError('Amount must be a positive number');
    const quote = await tx.mintQuotes.getMintQuote(mintUrl, input.method, input.quoteId);
    if (!quote) throw new Error(`Mint quote ${input.quoteId} was not found`);
    assertSameUnit(quote.unit, unit, `Mint quote ${quote.quoteId}`);
    const fixedAmount = getMintQuoteAmount(quote);
    if (fixedAmount && !fixedAmount.equals(input.amount)) {
      throw new Error(
        `Mint quote ${quote.quoteId} amount ${fixedAmount} does not match requested amount ${input.amount}`,
      );
    }
    const existing = await tx.mintOperations.getById(input.operationId);
    if (existing) {
      if (
        existing.mintUrl !== mintUrl ||
        existing.method !== input.method ||
        existing.quoteId !== input.quoteId ||
        existing.unit !== unit ||
        !existing.amount.equals(input.amount)
      ) {
        throw new Error(`Mint operation ${input.operationId} has a different intent`);
      }
      if (existing.state === 'pending') return { operation: existing, changed: false };
      if (existing.state !== 'init')
        throw new Error(`Cannot prepare operation ${existing.id} in state ${existing.state}`);
    }
    if (fixedAmount && quote.amountIssued.greaterThanOrEqual(fixedAmount))
      throw new Error(`Cannot prepare mint operation: quote is terminal`);
    if (fixedAmount) {
      const siblings = await tx.mintOperations.getByQuoteId(mintUrl, input.method, quote.quoteId);
      const sibling = siblings.find((op) => op.id !== input.operationId);
      if (sibling)
        throw new Error(
          `Mint quote ${quote.quoteId} is already tracked by operation ${sibling.id} in state ${sibling.state}`,
        );
    }
    const pubkey = quote.pubkey;
    if (
      (quote.method !== 'bolt11' && !pubkey) ||
      (pubkey && !(await tx.keypairs.getMintQuoteKey(pubkey)))
    ) {
      throw new MintQuoteKeyError('Missing NUT-20 mint quote key');
    }
    const allocation = await tx.outputs.allocate({
      mintUrl,
      unit,
      activeKeys: input.activeKeys,
      seed: input.seed,
      keepAmount: input.amount,
      sendAmount: Amount.zero(),
    });
    if (allocation.outputData.keep.length === 0)
      throw new Error('Failed to create deterministic outputs for mint operation');
    const operation: PendingMintOperation = {
      id: input.operationId,
      mintUrl,
      method: input.method,
      methodData: existing?.methodData ?? {},
      quoteId: quote.quoteId,
      amount: input.amount,
      unit,
      request: quote.request,
      expiry: quote.expiry,
      pubkey,
      outputData: allocation.outputData,
      state: 'pending',
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    };
    assertMintOutputPlan(operation);
    if (existing) await tx.mintOperations.update(operation);
    else await tx.mintOperations.create(operation);
    return { operation, counter: allocation.counter, changed: true };
  });
}

/** Claimable balance and the executing reservation are read/written under the same adapter lock. */
export function beginMintExecution(
  tx: CoreTransaction,
  input: BeginMintExecutionInput,
): Promise<BeginMintExecutionResult> {
  return trackTransactionWork(tx, async () => {
    const operation = await requireOperation(tx, input.operationId);
    if (operation.state !== 'pending') return { operation, changed: false };
    await tx.mintMetadata.assertTrusted(operation.mintUrl);
    const quote = await tx.mintQuotes.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (!quote) throw new Error(`Mint quote ${operation.quoteId} was not found`);
    const siblings = await tx.mintOperations.getByQuoteId(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    const finalizedAmount = siblings.reduce(
      (sum, op) => (op.state === 'finalized' ? sum.add(op.amount) : sum),
      Amount.zero(),
    );
    const reservedAmount = siblings.reduce(
      (sum, op) => (op.state === 'executing' ? sum.add(op.amount) : sum),
      Amount.zero(),
    );
    const assessment = assessMintQuoteClaimability(quote, {
      finalizedAmount,
      reservedAmount,
      requestedAmount: operation.amount,
    });
    if (assessment.status === 'invalid')
      throw new Error(`Mint quote ${operation.quoteId} has invalid claimability accounting`);
    if ((quote.method === 'bolt11' && !reservedAmount.isZero()) || assessment.status === 'waiting')
      return { operation, changed: false };
    assertMintOutputPlan(operation);
    const executing: ExecutingMintOperation = {
      ...operation,
      state: 'executing',
      updatedAt: input.now,
      error: undefined,
    };
    await tx.mintOperations.update(executing);
    return { operation: executing, changed: true };
  });
}

/** Exact output proofs and finalized issuance commit together. Remote accounting is not fabricated. */
export function applyMintResult(
  tx: CoreTransaction,
  input: ApplyMintResultInput,
): Promise<ApplyMintResult> {
  return trackTransactionWork(tx, async () => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state === 'init' || !sameRequest(current, input.operation))
      throw new Error('Mint result does not match persisted request');
    if (current.state === 'finalized') return { operation: current, proofs: [], changed: false };
    if (current.state !== 'executing')
      throw new Error(`Cannot finalize operation ${current.id} in state ${current.state}`);
    assertMintOutputPlan(current);
    const candidates = mapProofToCoreProof(current.mintUrl, 'ready', input.proofs, {
      unit: current.unit,
      createdByOperationId: current.id,
    });
    const saved = await tx.proofs.getProofsBySecrets(
      current.mintUrl,
      getOutputProofSecrets(current),
    );
    if (new Set(candidates.map((proof) => proof.secret)).size !== candidates.length)
      throw new ProofValidationError('Mint result contains duplicate proofs');
    const bySecret = new Map<string, CoreProof>(
      saved.map((proof) => [
        proof.secret,
        { ...proof, state: 'ready' as const, createdByOperationId: current.id },
      ]),
    );
    for (const proof of candidates) bySecret.set(proof.secret, proof);
    const proofs = [...bySecret.values()];
    assertOutputProofs({
      mintUrl: current.mintUrl,
      unit: current.unit,
      outputData: current.outputData,
      kind: 'keep',
      state: 'ready',
      createdByOperationId: current.id,
      proofs,
    });
    await tx.proofs.saveCreated(current.mintUrl, proofs);
    const operation: FinalizedMintOperation = {
      ...current,
      state: 'finalized',
      updatedAt: input.now,
      error: undefined,
    };
    await tx.mintOperations.update(operation);
    return { operation, proofs: candidates, changed: true };
  });
}

/** Call only with positive non-issuance evidence; transport/validation failures remain recoverable. */
export function failMint(tx: CoreTransaction, input: FailMintInput): Promise<FailMintResult> {
  return trackTransactionWork(tx, async () => {
    const current = await requireOperation(tx, input.operationId);
    if (isTerminalOperation(current)) return { operation: current, changed: false };
    if (current.state !== input.expectedState)
      throw new Error(`Cannot fail operation ${current.id} in state ${current.state}`);
    const operation: FailedMintOperation = {
      ...current,
      state: 'failed',
      updatedAt: input.now,
      error: input.failure.reason,
      terminalFailure: input.failure,
    };
    await tx.mintOperations.update(operation);
    return { operation, changed: true };
  });
}

/** Clean up pre-migration init rows, which never authorized submission. */
export function cleanupMintInit(tx: CoreTransaction, operationId: string) {
  return trackTransactionWork(tx, async () => {
    const current = await tx.mintOperations.getById(operationId);
    if (current?.state !== 'init') return;
    await tx.mintOperations.delete(operationId);
  });
}

/** Preserve the executing reservation and exact request after inconclusive recovery. */
export function deferMintRecovery(tx: CoreTransaction, input: DeferMintRecoveryInput) {
  return trackTransactionWork(tx, async () => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state !== 'executing') return;
    if (!sameRequest(current, input.operation))
      throw new Error('Mint recovery does not match persisted request');
    await tx.mintOperations.update({ ...current, updatedAt: input.now, error: input.error });
  });
}

async function requireOperation(tx: CoreTransaction, id: string): Promise<MintOperation> {
  const operation = await tx.mintOperations.getById(id);
  if (!operation) throw new Error(`Operation ${id} not found`);
  return operation;
}

function sameRequest(a: Exclude<MintOperation, { state: 'init' }>, b: ExecutingMintOperation) {
  return (
    a.mintUrl === b.mintUrl &&
    a.method === b.method &&
    a.quoteId === b.quoteId &&
    a.unit === b.unit &&
    a.amount.equals(b.amount) &&
    a.pubkey === b.pubkey &&
    a.request === b.request &&
    JSON.stringify(a.outputData) === JSON.stringify(b.outputData)
  );
}

function assertMintOutputPlan(operation: PendingOrLaterOperation): void {
  const outputs = operation.outputData.keep;
  const amount = outputs.reduce(
    (sum, output) => sum.add(Amount.from(output.blindedMessage.amount)),
    Amount.zero(),
  );
  if (
    outputs.length === 0 ||
    !amount.equals(operation.amount) ||
    operation.outputData.send.length !== 0 ||
    new Set(outputs.map((output) => output.blindedMessage.id)).size !== 1 ||
    new Set(outputs.map((output) => output.secret)).size !== outputs.length
  ) {
    throw new ProofValidationError('Mint output plan does not match operation amount');
  }
}
