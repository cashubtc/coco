import { Amount, signMintQuote } from '@cashu/cashu-ts';
import { bytesToHex } from '@noble/curves/utils.js';
import { normalizeUnit } from '../../amounts.ts';
import {
  BatchMintAdmissionError,
  MintQuoteKeyError,
  ProofValidationError,
} from '../../models/Error.ts';
import { assertOutputProofs } from '../../proofs/OutputProofs.ts';
import type { CoreTransaction } from '../../transactions/CoreTransaction.ts';
import { defineTransition } from '../../transactions/Transition.ts';
import { assessMintQuoteClaim } from '../../transactions/mintQuoteClaims/ScopedMintQuoteClaims.ts';
import type { CoreProof } from '../../types.ts';
import {
  getSecretsFromSerializedOutputData,
  mapProofToCoreProof,
  normalizeMintUrl,
} from '../../utils.ts';
import { isTerminalOperation } from '../mint/MintOperation.ts';
import { assertOrdinaryChildWork } from '../mintSwap/MintSwapTransitions.ts';
import type {
  BatchMintMember,
  BatchMintOperation,
  ExecutingBatchMintOperation,
  FailedBatchMintOperation,
  FinalizedBatchMintOperation,
} from './BatchMintOperation.ts';
import type {
  AdmitBatchMintInput,
  AdmitBatchMintResult,
  ApplyBatchMintResult,
  ApplyBatchMintResultInput,
  DeferBatchMintRecoveryInput,
  FailBatchMintInput,
  FailBatchMintResult,
} from './BatchMintTransitionTypes.ts';

/**
 * Admission, Output Allocation, per-member NUT-20 signatures and Mint Quote Reservations commit
 * together as `executing`, in exact caller order. Every check reads the caller's scope, so a
 * concurrent standalone claim or batch for the same quote cannot both commit.
 */
export const admitBatchMint = defineTransition<AdmitBatchMintInput, AdmitBatchMintResult>(
  async (tx, input) => {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const unit = normalizeUnit(input.unit);
    const { method } = input;
    if (input.members.length < 2)
      throw new BatchMintAdmissionError(
        'too_few_members',
        'A Batch Mint Operation needs at least 2 members',
      );
    if (new Set(input.members.map((member) => member.quoteId)).size !== input.members.length)
      throw new BatchMintAdmissionError('duplicate_member', 'Batch Mint members must be unique');
    await tx.mintMetadata.assertTrusted(mintUrl);
    if (await tx.batchMintOperations.getById(input.operationId))
      throw new Error(`Batch Mint Operation ${input.operationId} already exists`);

    const admitted: Array<Omit<BatchMintMember, 'signature'> & { privkey?: string }> = [];
    for (const [ordinal, member] of input.members.entries()) {
      const { quoteId } = member;
      await tx.perform(assertOrdinaryChildWork, {
        kind: 'mint',
        target: { mintUrl, method, quoteId },
        authority: 'resolve',
      });
      const quote = await tx.mintQuotes.getMintQuoteById({ mintUrl, quoteId });
      if (!quote)
        throw new BatchMintAdmissionError(
          'quote_missing',
          `Mint quote ${quoteId} was not found`,
          quoteId,
        );
      if (quote.method !== method)
        throw new BatchMintAdmissionError(
          'mixed_method',
          `Mint quote ${quoteId} uses method ${quote.method}, not ${method}`,
          quoteId,
        );
      if (normalizeUnit(quote.unit) !== unit)
        throw new BatchMintAdmissionError(
          'mixed_unit',
          `Mint quote ${quoteId} uses unit ${quote.unit}, not ${unit}`,
          quoteId,
        );
      const facts = await tx.mintQuoteClaims.getFacts({ mintUrl, method, quoteId });
      const standalone = facts.standaloneOperations.find((op) => !isTerminalOperation(op));
      if (standalone)
        throw new BatchMintAdmissionError(
          'standalone_operation',
          `Mint quote ${quoteId} is claimed by Mint Operation ${standalone.id} in state ${standalone.state}`,
          quoteId,
        );
      const assessment = assessMintQuoteClaim(quote, facts, member.amount);
      if (assessment.status === 'invalid' && method === 'bolt11' && member.amount)
        throw new BatchMintAdmissionError(
          'amount_mismatch',
          `Mint quote ${quoteId} amount does not match requested amount ${member.amount}`,
          quoteId,
        );
      if (assessment.status !== 'claimable' || !assessment.claimAmount)
        throw new BatchMintAdmissionError(
          'unclaimable',
          `Mint quote ${quoteId} is not claimable${member.amount ? ` for ${member.amount}` : ''}`,
          quoteId,
        );
      const amount = assessment.claimAmount;
      await tx.mintMetadata.assertCanMint(mintUrl, method, unit, amount);
      const pubkey = quote.pubkey;
      if (method !== 'bolt11' && !pubkey)
        throw new MintQuoteKeyError(`Mint quote ${quoteId} has no NUT-20 quote key`);
      const key = pubkey ? await tx.keypairs.getMintQuoteKey(pubkey) : null;
      if (pubkey && !key)
        throw new MintQuoteKeyError(`Missing NUT-20 mint quote key for quote ${quoteId}`);
      admitted.push({
        ordinal,
        quoteId,
        amount,
        request: quote.request,
        ...(key ? { privkey: bytesToHex(key.secretKey) } : {}),
      });
    }

    const allocation = await tx.outputs.allocate({
      mintUrl,
      unit,
      activeKeys: input.activeKeys,
      seed: input.seed,
      keepAmount: admitted.reduce((sum, member) => sum.add(member.amount), Amount.zero()),
      sendAmount: Amount.zero(),
    });
    // Every NUT-20 signature covers its quote ID and the complete aggregate outputs.
    const outputs = allocation.outputData.keep.map(({ blindedMessage }) => ({
      ...blindedMessage,
      amount: Amount.from(blindedMessage.amount),
    }));
    const operation: ExecutingBatchMintOperation = {
      id: input.operationId,
      mintUrl,
      method,
      unit,
      members: admitted.map(({ privkey, ...member }) => ({
        ...member,
        signature: privkey ? signMintQuote(privkey, member.quoteId, outputs) : null,
      })),
      outputData: allocation.outputData,
      state: 'executing',
      createdAt: input.now,
      updatedAt: input.now,
    };
    assertBatchMintOutputPlan(operation);
    await tx.batchMintOperations.create(operation);
    return { operation, counter: allocation.counter };
  },
);

/**
 * Save the complete validated proof set, attributed only to the batch, and finalize atomically.
 * Remote Mint Quote Accounting is not fabricated; member amounts count as local issuance.
 */
export const applyBatchMintResult = defineTransition<
  ApplyBatchMintResultInput,
  ApplyBatchMintResult
>(async (tx, input) => {
  const current = await requireOperation(tx, input.operation.id);
  if (!sameRequest(current, input.operation))
    throw new Error('Batch Mint result does not match persisted request');
  if (current.state === 'finalized') return { operation: current, proofs: [], changed: false };
  if (current.state !== 'executing')
    throw new Error(`Cannot finalize Batch Mint Operation ${current.id} in state ${current.state}`);
  assertBatchMintOutputPlan(current);
  const candidates = mapProofToCoreProof(current.mintUrl, 'ready', input.proofs, {
    unit: current.unit,
    createdByOperationId: current.id,
  });
  if (new Set(candidates.map((proof) => proof.secret)).size !== candidates.length)
    throw new ProofValidationError('Batch Mint result contains duplicate proofs');
  const saved = await tx.proofs.getProofsBySecrets(
    current.mintUrl,
    getSecretsFromSerializedOutputData(current.outputData).keepSecrets,
  );
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
  const operation: FinalizedBatchMintOperation = {
    ...current,
    state: 'finalized',
    updatedAt: input.now,
    error: undefined,
  };
  await tx.batchMintOperations.update(operation);
  return { operation, proofs: candidates, changed: true };
});

/** Call only with positive non-issuance evidence; this releases every member's reservation. */
export const failBatchMint = defineTransition<FailBatchMintInput, FailBatchMintResult>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operationId);
    if (current.state !== 'executing') return { operation: current, changed: false };
    const operation: FailedBatchMintOperation = {
      ...current,
      state: 'failed',
      updatedAt: input.now,
      error: input.failure.reason,
      terminalFailure: input.failure,
    };
    await tx.batchMintOperations.update(operation);
    return { operation, changed: true };
  },
);

/** Keep the reservations and exact request after an ambiguous outcome, recording its error. */
export const deferBatchMintRecovery = defineTransition<DeferBatchMintRecoveryInput, void>(
  async (tx, input) => {
    const current = await requireOperation(tx, input.operation.id);
    if (current.state !== 'executing') return;
    if (!sameRequest(current, input.operation))
      throw new Error('Batch Mint recovery does not match persisted request');
    await tx.batchMintOperations.update({ ...current, updatedAt: input.now, error: input.error });
  },
);

async function requireOperation(tx: CoreTransaction, id: string): Promise<BatchMintOperation> {
  const operation = await tx.batchMintOperations.getById(id);
  if (!operation) throw new Error(`Batch Mint Operation ${id} not found`);
  return operation;
}

function sameRequest(a: BatchMintOperation, b: BatchMintOperation): boolean {
  return (
    a.mintUrl === b.mintUrl &&
    a.method === b.method &&
    a.unit === b.unit &&
    a.members.length === b.members.length &&
    a.members.every((member, index) => {
      const other = b.members[index]!;
      return (
        member.ordinal === other.ordinal &&
        member.quoteId === other.quoteId &&
        member.amount.equals(other.amount) &&
        member.signature === other.signature
      );
    }) &&
    JSON.stringify(a.outputData) === JSON.stringify(b.outputData)
  );
}

function assertBatchMintOutputPlan(operation: BatchMintOperation): void {
  const outputs = operation.outputData.keep;
  const outputAmount = outputs.reduce(
    (sum, output) => sum.add(Amount.from(output.blindedMessage.amount)),
    Amount.zero(),
  );
  const memberAmount = operation.members.reduce(
    (sum, member) => sum.add(member.amount),
    Amount.zero(),
  );
  if (
    outputs.length === 0 ||
    !outputAmount.equals(memberAmount) ||
    operation.outputData.send.length !== 0 ||
    new Set(outputs.map((output) => output.blindedMessage.id)).size !== 1 ||
    new Set(outputs.map((output) => output.secret)).size !== outputs.length
  ) {
    throw new ProofValidationError('Batch Mint output plan does not match member amounts');
  }
}
