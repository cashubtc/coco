import { Amount, type AmountLike } from '@cashu/cashu-ts';
import type { QuoteIdentity } from '../models/QuoteIdentity.ts';
import type { BatchMintOperation } from '../operations/batchMint/BatchMintOperation.ts';
import type { BatchMintOperationService } from '../operations/batchMint/BatchMintOperationService.ts';
import type { DefaultSupportedMintMethod } from './MintOpsApi.ts';

export interface ExecuteBatchMintInput {
  mintUrl: string;
  /** Built-in payment method shared by every member. */
  method: DefaultSupportedMintMethod;
  /**
   * Two or more distinct quotes, in the exact order of the NUT-29 request. `amount` defaults to
   * the member's full available amount; BOLT11 members must claim the quote amount.
   */
  members: Array<{ quoteId: string; amount?: AmountLike }>;
}

export interface BatchMintRecoveryApi {
  /** Recover every `executing` Batch Mint Operation now. */
  run(): Promise<void>;
}

/**
 * Explicit Batch Mint Operations: one atomic NUT-29 issuance for an exact ordered group of Mint
 * Quotes from one trusted mint, method and unit.
 *
 * `execute` rejects every admission failure before persisting anything and never falls back to
 * standalone Mint Operations. Members keep their own `type: 'mint'` history entries; the batch
 * publishes `batch-mint-op:*` events instead of `mint-op:*` events.
 */
export class BatchMintOpsApi {
  readonly recovery: BatchMintRecoveryApi = {
    run: () => this.service.recoverInFlight(),
  };

  constructor(private readonly service: BatchMintOperationService) {}

  /**
   * Admit, prepare and submit one exact NUT-29 request. Resolves `finalized` on issuance, `failed`
   * on a definitive rejection, or still `executing` when the outcome is ambiguous; recover it later
   * with `recovery.run()`.
   */
  execute(input: ExecuteBatchMintInput): Promise<BatchMintOperation> {
    return this.service.execute({
      mintUrl: input.mintUrl,
      method: input.method,
      members: input.members.map((member) => ({
        quoteId: member.quoteId,
        ...(member.amount === undefined ? {} : { amount: Amount.from(member.amount) }),
      })),
    });
  }

  /** Returns a Batch Mint Operation by ID, or `null` when it does not exist. */
  get(operationId: string): Promise<BatchMintOperation | null> {
    return this.service.getOperation(operationId);
  }

  /** Lists Batch Mint Operations in any state with a member for this quote. */
  listByQuote(input: QuoteIdentity): Promise<BatchMintOperation[]> {
    return this.service.listByQuote(input);
  }

  /** Lists Batch Mint Operations whose outcome is unresolved (`executing`). */
  listInFlight(): Promise<BatchMintOperation[]> {
    return this.service.listInFlight();
  }
}
