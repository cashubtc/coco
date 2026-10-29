/**
 * Why `ops.mint.batch.execute` rejected a group before persisting anything. Untrusted mints reject
 * with `UnknownMintError`, missing or non-owned quote keys with `MintQuoteKeyError`, and quotes
 * coordinated by an active Mint Swap with `MintSwapChildOperationError`.
 */
export type BatchMintAdmissionReason =
  | 'too_few_members'
  | 'duplicate_member'
  | 'unsupported_method'
  | 'batch_too_large'
  | 'quote_missing'
  | 'mixed_method'
  | 'mixed_unit'
  | 'amount_mismatch'
  | 'unclaimable'
  | 'standalone_operation';

/** A Batch Mint group failed admission; nothing was persisted and nothing was sent. */
export class BatchMintAdmissionError extends Error {
  constructor(
    readonly reason: BatchMintAdmissionReason,
    message: string,
    readonly quoteId?: string,
  ) {
    super(message);
    this.name = 'BatchMintAdmissionError';
  }
}
