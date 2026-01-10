import type { Proof } from '@cashu/cashu-ts';
import type {
  ExecutingMeltOperation,
  MeltMethodMeta,
  MeltMethod,
  ExecutionResult,
} from '@core/operations/melt';
import { deserializeOutputData, type SerializedOutputData } from '@core/utils';

// ============================================================================
// Types
// ============================================================================

/**
 * Quote response data needed for melt preparation.
 * Extracted from the mint's melt quote response.
 */
export interface MeltQuoteData {
  /** The quote ID from the mint */
  quote: string;
  /** The amount to melt (in sats) */
  amount: number;
  /** The fee reserve required by the mint */
  fee_reserve: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * If the selected proof amount exceeds the required amount by this ratio (10%),
 * we perform a swap first to get exact-amount proofs. This avoids sending
 * significantly more value to the mint than needed, which could result in
 * larger change amounts and potential privacy/fee implications.
 *
 * Example: If we need 100 sats but selected proofs total 115 sats,
 * that's 1.15x (15% over) which exceeds 1.1x, so we swap first.
 */
export const SWAP_THRESHOLD_RATIO = 1.1;

// ============================================================================
// Proof Helpers
// ============================================================================

/**
 * Calculate the total amount of a proof set.
 */
export function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
}

/**
 * Extract the send proof secrets from serialized swap output data.
 * These are the secrets of proofs that were created during the swap
 * and will be used as melt inputs.
 */
export function getSwapSendSecrets(swapOutputData: SerializedOutputData): string[] {
  return deserializeOutputData(swapOutputData).send.map((o) =>
    new TextDecoder().decode(o.secret),
  );
}

// ============================================================================
// Execution Result Builders
// ============================================================================

/**
 * Build a PAID execution result.
 * Used when the melt completed successfully.
 */
export function buildPaidResult<M extends MeltMethod>(
  operation: ExecutingMeltOperation & MeltMethodMeta<M>,
): ExecutionResult<M> {
  return {
    status: 'PAID',
    finalized: { ...operation, state: 'finalized', updatedAt: Date.now() },
  };
}

/**
 * Build a PENDING execution result.
 * Used when the melt is in-flight and awaiting confirmation.
 */
export function buildPendingResult<M extends MeltMethod>(
  operation: ExecutingMeltOperation & MeltMethodMeta<M>,
): ExecutionResult<M> {
  return {
    status: 'PENDING',
    pending: { ...operation, state: 'pending', updatedAt: Date.now() },
  };
}

/**
 * Build a FAILED execution result with optional error message.
 * Used when the melt failed and proofs need recovery.
 */
export function buildFailedResult<M extends MeltMethod>(
  operation: ExecutingMeltOperation & MeltMethodMeta<M>,
  error?: string,
): ExecutionResult<M> {
  return {
    status: 'FAILED',
    failed: { ...operation, state: 'failed', updatedAt: Date.now(), error },
  };
}
