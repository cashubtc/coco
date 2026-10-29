import { Amount, CTSError, type Proof } from '@cashu/cashu-ts';
import type { EventBus } from '../../events/EventBus.ts';
import type { CoreEvents } from '../../events/types.ts';
import { restoreOutputProofs } from '../../infra/ProofRestore.ts';
import type { Logger } from '../../logging/Logger.ts';
import {
  BatchMintAdmissionError,
  HttpResponseError,
  MintOperationError,
  NetworkError,
  ProofValidationError,
  UnknownMintError,
} from '../../models/Error.ts';
import type { MintQuote } from '../../models/MintQuote.ts';
import { assessMintQuoteClaimability } from '../../models/MintQuoteClaimability.ts';
import type { QuoteIdentity } from '../../models/QuoteIdentity.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import type { QuoteLifecycle } from '../../quotes/QuoteLifecycle.ts';
import type { ProofRepository } from '../../repositories/index.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import type { CoreTransactionRunner } from '../../transactions/CoreTransaction.ts';
import {
  deserializeOutputData,
  generateSubId,
  getSecretsFromSerializedOutputData,
  normalizeMintUrl,
} from '../../utils.ts';
import { MintScopedLock } from '../MintScopedLock.ts';
import { OperationIdLock } from '../OperationIdLock.ts';
import type { MintMethod } from '../mint/MintMethodHandler.ts';
import { assertOrdinaryChildWork } from '../mintSwap/MintSwapTransitions.ts';
import type { BatchMintOperation, ExecutingBatchMintOperation } from './BatchMintOperation.ts';
import type { BatchMintOperationRepository } from './BatchMintOperationRepository.ts';
import type { AdmitBatchMintResult } from './BatchMintTransitionTypes.ts';
import {
  admitBatchMint,
  applyBatchMintResult,
  deferBatchMintRecovery,
  failBatchMint,
} from './BatchMintTransitions.ts';

const BUILT_IN_METHODS = new Set<MintMethod>(['bolt11', 'bolt12', 'onchain']);

/**
 * NUT error codes proving the mint rejected the exact request without issuing. Codes that could
 * follow an earlier issuance of the same request (`10002` outputs already signed, `20002` quote
 * already issued) and unknown codes stay ambiguous, so recovery decides from Restore and a fresh
 * quote check instead.
 */
const DEFINITIVE_REJECTION_CODES = new Set([
  11005, 11006, 11008, 11009, 11010, 11012, 11014, 11015, 11016, 11017, 12001, 12002, 12003, 20001,
  20003, 20007, 20008, 20009,
]);

/**
 * Whether a failed submission shows the mint cannot batch this request at all: `11017` (batch too
 * large), an unsupported endpoint, or a response that cannot be read as a batch mint result.
 * Network, authentication, rate-limit and server failures, and other NUT codes, are not evidence.
 * This classification is independent of whether the outcome is definitive.
 */
function isBatchMintIncompatibility(error: unknown): boolean {
  // MintOperationError extends HttpResponseError, so NUT codes are classified first.
  if (error instanceof MintOperationError) return error.code === 11017;
  if (error instanceof NetworkError) return false;
  if (error instanceof HttpResponseError)
    return (
      (error.status >= 200 && error.status < 300) ||
      error.status === 404 ||
      error.status === 405 ||
      error.status === 501
    );
  // cashu-ts rejects an unreadable success response (missing or mismatched signatures) this way.
  return error instanceof CTSError;
}

export interface ExecuteBatchMintInput {
  mintUrl: string;
  method: MintMethod;
  /** Exact request order. Omit `amount` to claim a member's full available amount. */
  members: Array<{ quoteId: string; amount?: Amount }>;
}

export interface BatchMintOperationServiceDependencies {
  transactionRunner: CoreTransactionRunner;
  batchMintQueries: Pick<BatchMintOperationRepository, 'getById' | 'listByQuote' | 'listInFlight'>;
  proofQueries: Pick<ProofRepository, 'getProofBySecret'>;
  quoteLifecycle: Pick<
    QuoteLifecycle,
    'getMintQuote' | 'checkMintQuotesForPolling' | 'getMintQuotePollingLimit' | 'refreshMintQuote'
  >;
  mintService: Pick<
    MintService,
    'isTrustedMint' | 'getNut29BatchMintLimit' | 'refreshAndCommitIfStale'
  >;
  walletService: Pick<WalletService, 'getWalletWithActiveKeysetId'>;
  loadSeed: () => Promise<Uint8Array>;
  eventBus: EventBus<CoreEvents>;
  logger?: Logger;
  /** Shared with Mint so admission and standalone claims serialize on the same Quote Identity keys. */
  mintScopedLock?: MintScopedLock;
  operationIdLock?: OperationIdLock;
}

/**
 * Coordinates Batch Mint Operations: one atomic NUT-29 issuance for an exact ordered group of
 * Mint Quotes. Admission commits the complete request as `executing`; submission and recovery
 * only ever send that persisted request, and never fall back to standalone Mint Operations.
 */
export class BatchMintOperationService {
  private readonly mintScopedLock: MintScopedLock;
  private readonly operationIdLock: OperationIdLock;
  private recoveryInProgress = false;
  /** Mint-and-method groups whose batch endpoint proved incompatible during this Coco Session. */
  private readonly unavailableMethodsByMint = new Map<string, Set<MintMethod>>();

  constructor(private readonly dependencies: BatchMintOperationServiceDependencies) {
    this.mintScopedLock = dependencies.mintScopedLock ?? new MintScopedLock();
    this.operationIdLock = dependencies.operationIdLock ?? new OperationIdLock();
  }

  /**
   * Admit, prepare and submit one exact NUT-29 request. Admission failures reject before anything
   * is persisted. An ambiguous outcome returns the operation still `executing`.
   */
  async execute(input: ExecuteBatchMintInput): Promise<BatchMintOperation> {
    const mintUrl = normalizeMintUrl(input.mintUrl);
    const { method, members } = input;
    if (members.length < 2)
      throw new BatchMintAdmissionError(
        'too_few_members',
        'A Batch Mint Operation needs at least 2 members',
      );
    if (new Set(members.map((member) => member.quoteId)).size !== members.length)
      throw new BatchMintAdmissionError('duplicate_member', 'Batch Mint members must be unique');
    if (!BUILT_IN_METHODS.has(method))
      throw new BatchMintAdmissionError(
        'unsupported_method',
        `Batch minting does not support method ${method}`,
      );
    if (!(await this.dependencies.mintService.isTrustedMint(mintUrl)))
      throw new UnknownMintError(`Mint ${mintUrl} is not trusted`);
    const limit = await this.dependencies.mintService.getNut29BatchMintLimit(mintUrl, method);
    // A malformed or single-quote `max_batch_size` admits no batch, which is not a size problem.
    if (limit < 2)
      throw new BatchMintAdmissionError(
        'unsupported_method',
        limit === 0
          ? `Mint ${mintUrl} does not advertise NUT-29 batch minting for ${method}`
          : `Mint ${mintUrl} advertises no usable NUT-29 batch size for ${method}`,
      );
    if (members.length > limit)
      throw new BatchMintAdmissionError(
        'batch_too_large',
        `Batch of ${members.length} exceeds the NUT-29 limit of ${limit} for ${method}`,
      );

    // Reject quotes an active Mint Swap coordinates before waiting on locks; admission rechecks.
    await this.dependencies.transactionRunner.run(async (tx) => {
      for (const member of members)
        await tx.perform(assertOrdinaryChildWork, {
          kind: 'mint',
          target: { mintUrl, method, quoteId: member.quoteId },
          authority: 'resolve',
        });
    });

    const operationId = generateSubId();
    const releaseOperation = await this.operationIdLock.acquire(operationId);
    try {
      const admitted = await this.admit(operationId, mintUrl, input);
      // Publish after releasing quote locks so listeners may claim quotes without deadlock.
      if (admitted.counter) await this.publish('counter:updated', admitted.counter);
      await this.publish('batch-mint-op:executing', {
        mintUrl,
        operationId,
        operation: admitted.operation,
      });
      return await this.submit(admitted.operation);
    } finally {
      releaseOperation();
    }
  }

  async getOperation(id: string): Promise<BatchMintOperation | null> {
    return this.dependencies.batchMintQueries.getById(id);
  }

  async listByQuote(identity: QuoteIdentity): Promise<BatchMintOperation[]> {
    return this.dependencies.batchMintQueries.listByQuote({
      mintUrl: normalizeMintUrl(identity.mintUrl),
      quoteId: identity.quoteId,
    });
  }

  async listInFlight(): Promise<BatchMintOperation[]> {
    return this.dependencies.batchMintQueries.listInFlight();
  }

  /**
   * @internal Whether automatic claiming should claim this mint and method through standalone Mint
   * Operations for the rest of the Coco Session, after a submission showed incompatibility. The
   * marker is never persisted and is separate from the NUT-29 quote-check marker; explicit
   * `execute` calls ignore it.
   */
  isBatchMintUnavailable(mintUrl: string, method: MintMethod): boolean {
    return this.unavailableMethodsByMint.get(normalizeMintUrl(mintUrl))?.has(method) === true;
  }

  private markBatchMintUnavailable(mintUrl: string, method: MintMethod, error: unknown): void {
    const methods = this.unavailableMethodsByMint.get(mintUrl) ?? new Set<MintMethod>();
    if (methods.has(method)) return;
    methods.add(method);
    this.unavailableMethodsByMint.set(mintUrl, methods);
    this.dependencies.logger?.warn('Disabling automatic batch minting for the Coco Session', {
      mintUrl,
      method,
      error: message(error),
    });
  }

  isRecoveryInProgress(): boolean {
    return this.recoveryInProgress;
  }

  /** Recover every `executing` operation not currently held by this session. */
  async recoverInFlight(): Promise<void> {
    if (this.recoveryInProgress) return;
    this.recoveryInProgress = true;
    try {
      for (const operation of await this.dependencies.batchMintQueries.listInFlight()) {
        if (this.operationIdLock.isLocked(operation.id)) continue;
        try {
          await this.recover(operation.id);
        } catch (error) {
          this.dependencies.logger?.error('Error recovering Batch Mint Operation', {
            operationId: operation.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.recoveryInProgress = false;
    }
  }

  /**
   * Recover one operation: saved proofs, then NUT-09 Restore of the persisted outputs, then a fresh
   * target-isolated quote check whose observations are recorded before acting. Only zero restored outputs
   * with every member still claimable replays the exact request.
   */
  async recover(operationId: string): Promise<BatchMintOperation> {
    const release = await this.operationIdLock.acquire(operationId);
    try {
      const current = await this.dependencies.batchMintQueries.getById(operationId);
      if (!current) throw new Error(`Batch Mint Operation ${operationId} not found`);
      if (current.state !== 'executing') return current;

      if (await this.hasSavedOutputs(current)) return await this.settle(current, []);
      if (!(await this.dependencies.mintService.isTrustedMint(current.mintUrl))) {
        this.dependencies.logger?.warn('Mint is not trusted, skipping Batch Mint recovery', {
          operationId,
          mintUrl: current.mintUrl,
        });
        return current;
      }

      let restored: Proof[];
      try {
        restored = await this.restoreOutputs(current);
      } catch (error) {
        return this.defer(current, `Restore unavailable: ${message(error)}`);
      }
      if (restored.length > 0) return this.settle(current, restored);

      const decision = await this.assessMembers(current);
      if (decision.status === 'unresolved') return this.defer(current, decision.error);
      if (decision.status === 'unclaimable') return this.fail(current, decision.reason);
      return this.submit(current);
    } finally {
      release();
    }
  }

  private async admit(
    operationId: string,
    mintUrl: string,
    input: ExecuteBatchMintInput,
  ): Promise<AdmitBatchMintResult> {
    const { method } = input;
    // Stable order prevents deadlock between overlapping groups and standalone claims.
    const quoteKeys = [
      ...new Set(input.members.map((m) => `${mintUrl}::${method}::${m.quoteId}`)),
    ].sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of quoteKeys) releases.push(await this.mintScopedLock.acquire(key));
      const first = await this.dependencies.quoteLifecycle.getMintQuote(
        mintUrl,
        method,
        input.members[0]!.quoteId,
      );
      if (!first)
        throw new BatchMintAdmissionError(
          'quote_missing',
          `Mint quote ${input.members[0]!.quoteId} was not found for ${method}`,
          input.members[0]!.quoteId,
        );
      // Keep same-session coordination with legacy output allocators, as Mint preparation does.
      releases.push(await this.mintScopedLock.acquire(mintUrl));
      const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(mintUrl);
      const activeKeys = createKeyChain(mintUrl, first.unit, metadata.keysets)
        .getCheapestKeyset()
        .toMintKeys();
      if (!activeKeys) throw new ProofValidationError('Active keyset is missing mint keys');
      const seed = await this.dependencies.loadSeed();
      const now = Date.now();
      const result = await this.dependencies.transactionRunner.run((tx) =>
        tx.perform(admitBatchMint, {
          operationId,
          mintUrl,
          method,
          unit: first.unit,
          members: input.members,
          activeKeys,
          seed,
          now,
        }),
      );
      return result;
    } finally {
      for (const release of releases.reverse()) release();
    }
  }

  /** Send exactly the persisted request through cashu-ts and settle its outcome. */
  private async submit(operation: ExecutingBatchMintOperation): Promise<BatchMintOperation> {
    let proofs: Proof[];
    let submitted = false;
    try {
      const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
        operation.mintUrl,
        operation.unit,
      );
      const outputs = deserializeOutputData(operation.outputData).keep;
      // Quotes are passed without pubkeys so cashu-ts does not sign again; the persisted
      // signatures, amounts and outputs form the exact request.
      const preview = await wallet.prepareBatchMint(
        operation.method,
        operation.members.map((member) => ({
          amount: member.amount,
          quote: { quote: member.quoteId },
        })),
        { keysetId: outputs[0]!.blindedMessage.id },
        { type: 'custom', data: outputs },
      );
      const persistedOutputs = operation.outputData.keep.map((output) => output.blindedMessage.B_);
      if (
        preview.payload.outputs.length !== persistedOutputs.length ||
        preview.payload.outputs.some((output, index) => output.B_ !== persistedOutputs[index])
      )
        throw new Error('Prepared Batch Mint outputs differ from the persisted request');
      const signatures = operation.members.map((member) => member.signature);
      submitted = true;
      proofs = await wallet.completeBatchMint({
        ...preview,
        payload: {
          quotes: operation.members.map((member) => member.quoteId),
          quote_amounts: operation.members.map((member) => member.amount),
          outputs: preview.payload.outputs,
          ...(signatures.some((signature) => signature !== null) ? { signatures } : {}),
        },
        legacySignatures: undefined,
      });
    } catch (error) {
      if (submitted && isBatchMintIncompatibility(error))
        this.markBatchMintUnavailable(operation.mintUrl, operation.method, error);
      if (error instanceof MintOperationError && DEFINITIVE_REJECTION_CODES.has(error.code))
        return this.fail(operation, error.message, String(error.code));
      return this.defer(operation, message(error));
    }
    return this.settle(operation, proofs);
  }

  /** Finalize from candidate proofs; an incomplete or invalid set leaves the operation executing. */
  private async settle(
    operation: ExecutingBatchMintOperation,
    proofs: Proof[],
  ): Promise<BatchMintOperation> {
    let result;
    try {
      const now = Date.now();
      result = await this.dependencies.transactionRunner.run((tx) =>
        tx.perform(applyBatchMintResult, { operation, proofs, now }),
      );
    } catch (error) {
      return this.defer(operation, message(error));
    }
    if (result.changed) {
      for (const keysetId of new Set(result.proofs.map((proof) => proof.id))) {
        await this.publish('proofs:saved', {
          mintUrl: operation.mintUrl,
          keysetId,
          proofs: result.proofs.filter((proof) => proof.id === keysetId),
        });
      }
      await this.publish('batch-mint-op:finalized', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: result.operation,
      });
    }
    return result.operation;
  }

  private async fail(
    operation: ExecutingBatchMintOperation,
    reason: string,
    code?: string,
  ): Promise<BatchMintOperation> {
    const now = Date.now();
    const result = await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(failBatchMint, {
        operationId: operation.id,
        failure: { reason, ...(code ? { code } : {}), observedAt: now },
        now,
      }),
    );
    if (result.changed && result.operation.state === 'failed')
      await this.publish('batch-mint-op:failed', {
        mintUrl: operation.mintUrl,
        operationId: operation.id,
        operation: result.operation,
      });
    return result.operation;
  }

  private async defer(
    operation: ExecutingBatchMintOperation,
    error: string,
  ): Promise<BatchMintOperation> {
    this.dependencies.logger?.warn('Batch Mint Operation outcome is unresolved', {
      operationId: operation.id,
      error,
    });
    const now = Date.now();
    await this.dependencies.transactionRunner.run((tx) =>
      tx.perform(deferBatchMintRecovery, { operation, error, now }),
    );
    return (await this.dependencies.batchMintQueries.getById(operation.id)) ?? operation;
  }

  /**
   * A fresh quote check after zero restored outputs. Any member unclaimable for its amount proves
   * the atomic request did not issue; malformed or unavailable evidence stays unresolved.
   */
  private async assessMembers(
    operation: ExecutingBatchMintOperation,
  ): Promise<
    | { status: 'claimable' }
    | { status: 'unclaimable'; reason: string }
    | { status: 'unresolved'; error: string }
  > {
    const { mintUrl, method } = operation;
    let quotes: Map<string, MintQuote>;
    try {
      quotes = await this.checkMemberQuotes(operation);
    } catch (error) {
      return { status: 'unresolved', error: message(error) };
    }
    const facts = await this.dependencies.transactionRunner.run(async (tx) => {
      const all = [];
      for (const member of operation.members)
        all.push(
          await tx.mintQuoteClaims.getFacts(
            { mintUrl, method, quoteId: member.quoteId },
            { excludeOperationId: operation.id },
          ),
        );
      return all;
    });
    for (const [index, member] of operation.members.entries()) {
      const quote = quotes.get(member.quoteId);
      if (!quote) return { status: 'unresolved', error: `Quote check omitted ${member.quoteId}` };
      const assessment = assessMintQuoteClaimability(quote, {
        finalizedAmount: facts[index]!.finalizedAmount,
        reservedAmount: facts[index]!.reservedAmount,
        requestedAmount: member.amount,
      });
      if (assessment.status === 'invalid')
        return {
          status: 'unresolved',
          error: `Mint quote ${member.quoteId} has invalid claimability accounting`,
        };
      if (assessment.status !== 'claimable')
        return {
          status: 'unclaimable',
          reason: `Mint quote ${member.quoteId} is no longer claimable for ${member.amount}`,
        };
    }
    return { status: 'claimable' };
  }

  /**
   * Recovery is explicit work, so its quote check stays target-isolated (ADR-0006): one NUT-29
   * check of exactly the members while that check is available for the mint and method, otherwise
   * one single-quote check per member. Both record Quote Observations before returning (ADR-0004).
   */
  private async checkMemberQuotes(
    operation: ExecutingBatchMintOperation,
  ): Promise<Map<string, MintQuote>> {
    const { mintUrl, method, members } = operation;
    const { quoteLifecycle } = this.dependencies;
    const quotes = new Map<string, MintQuote>();
    if ((await quoteLifecycle.getMintQuotePollingLimit(mintUrl, method)) < members.length) {
      for (const { quoteId } of members)
        quotes.set(quoteId, await quoteLifecycle.refreshMintQuote(mintUrl, method, quoteId));
      return quotes;
    }
    const result = await quoteLifecycle.checkMintQuotesForPolling(
      method,
      members.map(({ quoteId }) => ({ mintUrl, quoteId })),
    );
    for (const outcome of result.outcomes) {
      if (outcome.status !== 'updated')
        throw new Error(
          `Quote check failed for ${outcome.identity.quoteId}: ${outcome.failure.error.message}`,
        );
      quotes.set(outcome.identity.quoteId, outcome.quote);
    }
    return quotes;
  }

  private async restoreOutputs(operation: BatchMintOperation): Promise<Proof[]> {
    const metadata = await this.dependencies.mintService.refreshAndCommitIfStale(operation.mintUrl);
    const { wallet } = await this.dependencies.walletService.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return restoreOutputProofs(wallet, metadata.keysets, operation.unit, operation.outputData);
  }

  private async hasSavedOutputs(operation: BatchMintOperation): Promise<boolean> {
    const secrets = getSecretsFromSerializedOutputData(operation.outputData).keepSecrets;
    if (secrets.length === 0) return false;
    for (const secret of secrets) {
      if (!(await this.dependencies.proofQueries.getProofBySecret(operation.mintUrl, secret)))
        return false;
    }
    return true;
  }

  private async publish<E extends keyof CoreEvents>(
    event: E,
    payload: CoreEvents[E],
  ): Promise<void> {
    try {
      await this.dependencies.eventBus.emit(event, payload, { throwOnError: true });
    } catch (error) {
      this.dependencies.logger?.warn('Batch Mint event listener failed after commit', {
        event,
        error,
      });
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
