import type { Amount } from '@cashu/cashu-ts';

/** Values in a keyset result all use that result's unit. */
export interface SweepKeysetSummary {
  keysetId: string;
  unit: string;
  /** Present after discovery succeeds, including on later exchange failures. */
  pending?: { count: number; amount: Amount };
}

/** A completed transfer, successful skip/no-op, or an exchange needing attention. */
export type SweepKeysetResult = SweepKeysetSummary &
  (
    | { status: 'transferred'; receiveOperationId: string; received: Amount; fee: Amount }
    | { status: 'noop' }
    | { status: 'skipped'; reason: 'pending' }
    | { status: 'skipped'; reason: 'uneconomic'; available: Amount; fee: Amount }
    | { status: 'failed'; error: Error; receiveOperationId?: string }
    | { status: 'unresolved'; error: Error; receiveOperationId: string }
  );

/** Outcomes in discovery order. Amounts are never aggregated across units. */
export interface SweepReport {
  mintUrl: string;
  keysets: SweepKeysetResult[];
}
