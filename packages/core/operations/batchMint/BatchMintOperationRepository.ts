import type { QuoteIdentity } from '../../models/QuoteIdentity.ts';
import type { BatchMintOperation, BatchMintOperationState } from './BatchMintOperation.ts';

/**
 * Required Batch Mint persistence, bound to the active Wallet transaction's handle and lifetime.
 * A scoped handle must commit and roll back operations and member records with the Wallet
 * transaction.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export interface BatchMintPersistence {
  operationRepository: BatchMintOperationRepository;
}

/**
 * Persistence contract for Batch Mint Operations. Members are stored as separately indexed records
 * (operation, ordinal, Quote Identity, amount) and returned hydrated in ordinal order. Every read
 * returns an independent snapshot. Lists order by createdAt, then ID.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export interface BatchMintOperationRepository {
  /**
   * Validate with `assertBatchMintOperation`, normalize the mint URL, and create the operation with
   * its members. Reject an existing ID without mutation.
   */
  create(operation: BatchMintOperation): Promise<void>;
  /**
   * Replace the mutable outcome fields of an existing operation, preserving the supplied updatedAt.
   * Validate with `assertBatchMintUpdate`; membership and request material are immutable.
   */
  update(operation: BatchMintOperation): Promise<void>;
  getById(id: string): Promise<BatchMintOperation | null>;
  listByState(state: BatchMintOperationState): Promise<BatchMintOperation[]>;
  /** Operations whose outcome is unresolved (`executing`). */
  listInFlight(): Promise<BatchMintOperation[]>;
  /** Every operation in any state with a member for this Quote Identity; normalize the mint URL. */
  listByQuote(quote: QuoteIdentity): Promise<BatchMintOperation[]>;
}
