import { Amount } from '@cashu/cashu-ts';
import { assessMintQuoteClaimability } from '../../../models/MintQuoteClaimability.ts';
import type {
  MintOperation,
  PendingMintOperation,
} from '../../../operations/mint/MintOperation.ts';
import { mintLocalFacts } from '../../../operations/mint/MintReconciliation.ts';
import type {
  MintIssuanceReceipt,
  MintRecoveryRecord,
} from '../../../operations/mint/MintRecovery.ts';
import { newMintRecovery } from '../../../operations/mint/MintRecovery.ts';
import type { RepositoryTransactionScope } from '../../../repositories/index.ts';
import type { CoreProof } from '../../../types.ts';
import { deserializeOutputData } from '../../../utils.ts';
import type {
  AuthorizeMintCommand,
  MintCommit,
  MintCommands,
  PreparedMintCommit,
  PrepareMintCommand,
} from '../../../operations/mint/MintCommands.ts';

export type TransactionScopedMintCommands = MintCommands;

/** All repositories belong to one already-open scope. This module cannot open transactions. */
export class RepositoryMintCommands implements TransactionScopedMintCommands {
  constructor(private readonly scope: RepositoryTransactionScope) {}

  private async requireOperation(id: string) {
    const operation = await this.scope.mintOperationRepository.getById(id);
    if (!operation) throw new Error(`Operation ${id} not found`);
    return operation;
  }

  private async requireRecord(id: string) {
    const record = await this.scope.mintRecoveryRepository.get(id);
    if (!record || record.version !== 1)
      throw new Error(`Unsupported Mint recovery format for ${id}`);
    return record;
  }

  async prepare(command: PrepareMintCommand): Promise<PreparedMintCommit> {
    const { quote, amount, id, keysetId } = command;
    const canonical = await this.scope.mintQuoteRepository.getMintQuote(
      quote.mintUrl,
      quote.method,
      quote.quoteId,
    );
    if (
      !canonical ||
      canonical.request !== quote.request ||
      canonical.unit !== quote.unit ||
      canonical.pubkey !== quote.pubkey
    )
      throw new Error('Mint quote changed during preparation');
    if (!(await this.scope.mintRepository.isTrustedMint(quote.mintUrl)))
      throw new Error('Mint is not trusted');
    if (amount.isZero()) throw new Error('Mint amount must be positive');
    const current = await this.scope.counterRepository.getCounter(quote.mintUrl, keysetId);
    const counter = current?.counter ?? 0;
    const outputData = command.derive(counter);
    if (
      outputData.keep.length === 0 ||
      outputData.send.length !== 0 ||
      !Amount.sum(outputData.keep.map((o) => o.blindedMessage.amount)).equals(amount) ||
      outputData.keep.some((o) => o.blindedMessage.id !== keysetId) ||
      new Set(outputData.keep.map((o) => o.blindedMessage.B_)).size !== outputData.keep.length ||
      new Set(outputData.keep.map((o) => o.secret)).size !== outputData.keep.length
    )
      throw new Error('Invalid Mint output allocation');
    const nextCounter = counter + outputData.keep.length;
    if (!Number.isSafeInteger(nextCounter)) throw new Error('Mint output counter exhausted');
    const operation: PendingMintOperation = {
      id,
      mintUrl: quote.mintUrl,
      method: quote.method,
      methodData: {},
      quoteId: quote.quoteId,
      amount,
      unit: quote.unit,
      request: quote.request,
      pubkey: quote.pubkey,
      expiry: quote.expiry,
      outputData,
      state: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.scope.counterRepository.setCounter(quote.mintUrl, keysetId, nextCounter);
    await this.scope.mintOperationRepository.create(operation);
    await this.scope.mintRecoveryRepository.set(newMintRecovery(id));
    return { operation, counter: { mintUrl: quote.mintUrl, keysetId, counter: nextCounter } };
  }

  /** Migrate the entire sibling set before any admission, preserving every unknown commitment. */
  private async migrateSiblings(operation: MintOperation) {
    const siblings = await this.scope.mintOperationRepository.getByQuoteId(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    const records = new Map<string, MintRecoveryRecord>();
    for (const sibling of siblings) {
      let record = await this.scope.mintRecoveryRepository.get(sibling.id);
      if (record && record.version !== 1) throw new Error('Unsupported Mint recovery version');
      if (!record && sibling.state !== 'init') {
        record = {
          ...newMintRecovery(sibling.id),
          provenance:
            sibling.state === 'finalized' || sibling.state === 'failed'
              ? 'settled'
              : 'legacy-unknown',
        };
        await this.scope.mintRecoveryRepository.set(record);
      }
      if (record) records.set(sibling.id, record);
    }
    return { siblings, records };
  }

  async migrate(operationId: string): Promise<MintCommit> {
    let operation = await this.requireOperation(operationId);
    const { records } = await this.migrateSiblings(operation);
    const recovery = records.get(operationId);
    let changed = false;
    if (operation.state === 'init') {
      await this.scope.mintOperationRepository.delete(operationId);
    } else if (operation.state === 'pending' && recovery?.provenance === 'legacy-unknown') {
      operation = {
        ...operation,
        state: 'executing',
        error: 'Legacy submission history is unknown; exact-output recovery required',
        updatedAt: Date.now(),
      };
      await this.scope.mintOperationRepository.update(operation);
      changed = true;
    }
    return { operation, recovery, changed, proofs: [] };
  }

  async authorize(command: AuthorizeMintCommand): Promise<MintCommit> {
    const operation = await this.requireOperation(command.operationId);
    const { siblings, records } = await this.migrateSiblings(operation);
    const recovery = records.get(operation.id);
    if (operation.state !== 'pending' || recovery?.provenance !== 'prepared')
      return { operation, recovery, changed: false, proofs: [] };
    const quote = await this.scope.mintQuoteRepository.getMintQuote(
      operation.mintUrl,
      operation.method,
      operation.quoteId,
    );
    if (
      !quote ||
      quote.request !== operation.request ||
      quote.unit !== operation.unit ||
      quote.pubkey !== operation.pubkey
    )
      throw new Error('Mint quote identity conflict');
    if (!(await this.scope.mintRepository.isTrustedMint(operation.mintUrl)))
      throw new Error('Mint is not trusted');
    const assessment = assessMintQuoteClaimability(quote, {
      ...mintLocalFacts(siblings, records, operation.id),
      requestedAmount: operation.amount,
    });
    if (assessment.status === 'invalid') throw new Error('Invalid Mint quote accounting');
    if (assessment.status !== 'claimable')
      return { operation, recovery, changed: false, proofs: [] };
    const expected = operation.outputData.keep.map((o) => o.blindedMessage);
    if (
      command.request.quote !== operation.quoteId ||
      JSON.stringify(command.request.outputs) !== JSON.stringify(expected)
    )
      throw new Error('Mint request changed output identity');
    if (operation.pubkey && !command.request.signature)
      throw new Error('Missing Mint quote signature');
    const facts = mintLocalFacts(siblings, records, operation.id);
    const completed = Amount.sum(
      siblings.filter((op) => op.state === 'finalized').map((op) => op.amount),
    );
    const priorBaseline = facts.finalizedAmount.subtract(completed);
    // Advance the baseline only with no unresolved local transmission whose issuance could
    // already be included in the remote total. Failed sibling reservations leave no holes.
    const observedBaseline =
      facts.reservedAmount.isZero() && quote.amountIssued.greaterThan(completed)
        ? quote.amountIssued.subtract(completed)
        : Amount.zero();
    const baseline = observedBaseline.greaterThan(priorBaseline) ? observedBaseline : priorBaseline;
    const next: MintRecoveryRecord = {
      ...recovery,
      issuanceBaseline: baseline.toString(),
      revision: recovery.revision + 1,
      provenance: 'authorized',
      transmission: 'authorized',
      request: command.request,
      legacySignature: command.legacySignature,
    };
    const executing = {
      ...operation,
      state: 'executing' as const,
      updatedAt: Date.now(),
      error: undefined,
    };
    await this.scope.mintRecoveryRepository.set(next);
    await this.scope.mintOperationRepository.update(executing);
    return { operation: executing, recovery: next, changed: true, proofs: [] };
  }

  async applyEvidence(operationId: string, receipts: MintIssuanceReceipt[]): Promise<MintCommit> {
    const operation = await this.requireOperation(operationId);
    const recovery = await this.requireRecord(operationId);
    if (operation.state !== 'executing' && operation.state !== 'finalized')
      return { operation, recovery, changed: false, proofs: [] };
    const outputs = deserializeOutputData(operation.outputData).keep;
    if (
      operation.outputData.send.length ||
      !outputs.length ||
      !Amount.sum(outputs.map((output) => output.blindedMessage.amount)).equals(operation.amount) ||
      new Set(outputs.map((output) => output.blindedMessage.B_)).size !== outputs.length ||
      new Set(outputs.map((output) => new TextDecoder().decode(output.secret))).size !==
        outputs.length
    ) {
      throw new Error('Mint output plan does not cover the exact operation amount');
    }

    const merged = new Map(recovery.receipts.map((r) => [r.B_, r]));
    for (const receipt of receipts) {
      const output = outputs.find((o) => o.blindedMessage.B_ === receipt.B_);
      if (
        !output ||
        receipt.proof.secret !== new TextDecoder().decode(output.secret) ||
        receipt.proof.id !== output.blindedMessage.id ||
        !Amount.from(receipt.proof.amount).equals(output.blindedMessage.amount)
      )
        throw new Error('Mint evidence does not match exact outputs');
      const prior = merged.get(receipt.B_);
      if (
        prior &&
        (prior.proof.C !== receipt.proof.C ||
          prior.proof.id !== receipt.proof.id ||
          prior.proof.amount !== receipt.proof.amount)
      )
        throw new Error('Conflicting Mint issuance evidence');
      merged.set(
        receipt.B_,
        prior?.state === 'SPENT' ? prior : receipt.state === 'UNKNOWN' && prior ? prior : receipt,
      );
    }
    const complete = outputs.length > 0 && merged.size === outputs.length;
    const proofs: CoreProof[] = [];
    if (complete) {
      for (const receipt of merged.values()) {
        if (receipt.state === 'UNKNOWN' || receipt.state === 'PENDING') continue; // Durable holding area; never count unknown state as ready.
        const existing = await this.scope.proofRepository.getProofBySecret(
          operation.mintUrl,
          receipt.proof.secret,
        );
        if (existing) {
          if (
            existing.id !== receipt.proof.id ||
            !existing.amount.equals(receipt.proof.amount) ||
            existing.unit !== operation.unit ||
            existing.C !== receipt.proof.C ||
            (existing.createdByOperationId && existing.createdByOperationId !== operation.id)
          )
            throw new Error('Mint proof ownership conflict');
          // Never overwrite a proof already reserved/spent by a later operation.
          continue;
        }
        const proof: CoreProof = {
          ...receipt.proof,
          amount: Amount.from(receipt.proof.amount),
          mintUrl: operation.mintUrl,
          unit: operation.unit,
          state:
            receipt.state === 'UNSPENT'
              ? 'ready'
              : receipt.state === 'SPENT'
                ? 'spent'
                : 'inflight',
          createdByOperationId: operation.id,
        };
        proofs.push(proof);
      }
      await this.scope.proofRepository.saveProofs(operation.mintUrl, proofs);
    }
    const next = {
      ...recovery,
      revision: recovery.revision + 1,
      receipts: [...merged.values()],
      provenance: complete ? ('settled' as const) : recovery.provenance,
    };
    const updated = complete
      ? { ...operation, state: 'finalized' as const, updatedAt: Date.now(), error: undefined }
      : {
          ...operation,
          error: merged.size
            ? 'Partial issuance evidence; remaining outputs unresolved'
            : 'Issuance outcome unresolved',
          updatedAt: Date.now(),
        };
    await this.scope.mintRecoveryRepository.set(next);
    await this.scope.mintOperationRepository.update(updated);
    return {
      operation: updated,
      recovery: next,
      changed: complete && operation.state !== 'finalized',
      proofs,
    };
  }

  async reject(
    operationId: string,
    revision: number,
    error: string,
    useLegacy: boolean,
  ): Promise<MintCommit> {
    const operation = await this.requireOperation(operationId);
    const recovery = await this.requireRecord(operationId);
    if (
      operation.state !== 'executing' ||
      recovery.revision !== revision ||
      recovery.transmission !== 'authorized' ||
      recovery.provenance !== 'authorized' ||
      recovery.receipts.length
    )
      return { operation, recovery, changed: false, proofs: [] };
    if (
      useLegacy &&
      recovery.variant === 'current' &&
      recovery.legacySignature &&
      recovery.request
    ) {
      const next = {
        ...recovery,
        revision: revision + 1,
        variant: 'legacy' as const,
        rejectedRequest: recovery.request,
        request: { ...recovery.request, signature: recovery.legacySignature },
      };
      await this.scope.mintRecoveryRepository.set(next);
      return { operation, recovery: next, changed: true, proofs: [] };
    }
    const failed = {
      ...operation,
      state: 'failed' as const,
      error,
      terminalFailure: { reason: error, observedAt: Date.now() },
      updatedAt: Date.now(),
    };
    const next = {
      ...recovery,
      revision: revision + 1,
      transmission: 'rejected' as const,
      provenance: 'settled' as const,
    };
    await this.scope.mintRecoveryRepository.set(next);
    await this.scope.mintOperationRepository.update(failed);
    return { operation: failed, recovery: next, changed: true, proofs: [] };
  }

  async noteAmbiguity(operationId: string, revision: number, error: string): Promise<MintCommit> {
    const operation = await this.requireOperation(operationId);
    const recovery = await this.requireRecord(operationId);
    if (operation.state !== 'executing' || recovery.revision !== revision)
      return { operation, recovery, changed: false, proofs: [] };
    const next = { ...recovery, revision: revision + 1, transmission: 'ambiguous' as const };
    const updated = { ...operation, error, updatedAt: Date.now() };
    await this.scope.mintRecoveryRepository.set(next);
    await this.scope.mintOperationRepository.update(updated);
    return { operation: updated, recovery: next, changed: false, proofs: [] };
  }
}
