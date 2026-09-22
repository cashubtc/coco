import { Amount } from '@cashu/cashu-ts';
import type { MintSwapOperation } from './MintSwapOperation.ts';
import { parseMintSwapOperation } from './parseMintSwapOperation.ts';

const AMOUNT_FIELDS = new Set([
  'destinationAmount',
  'sourceDebitCap',
  'minimum',
  'maximum',
  'reserved',
  'returned',
  'finalDebit',
  'totalFee',
  'quoteAmountIssued',
  'storedProofAmount',
]);

function transformAmounts(value: unknown, serialize: boolean, key?: string): unknown {
  if (value !== undefined && value !== null && key && AMOUNT_FIELDS.has(key)) {
    return serialize ? Amount.from(value as Amount).toString() : Amount.from(value as string);
  }
  if (Array.isArray(value)) return value.map((item) => transformAmounts(item, serialize));
  if (typeof value !== 'object' || value === null) return value;

  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      transformAmounts(child, serialize, childKey),
    ]),
  );
}

/** Serialize a validated Mint Swap record without losing integer Amount precision. */
export function serializeMintSwapOperation(operation: MintSwapOperation): string {
  return JSON.stringify(transformAmounts(parseMintSwapOperation(operation), true));
}

/** Hydrate an untrusted stored record through the authoritative V1 parser. */
export function deserializeMintSwapOperation(recordJson: string): MintSwapOperation {
  return parseMintSwapOperation(transformAmounts(JSON.parse(recordJson), false));
}

export function compareMintSwapIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareMintSwapCreated(left: MintSwapOperation, right: MintSwapOperation): number {
  return left.createdAt - right.createdAt || compareMintSwapIds(left.id, right.id);
}

export function compareMintSwapDue(left: MintSwapOperation, right: MintSwapOperation): number {
  return (
    left.retry.nextAttemptAt! - right.retry.nextAttemptAt! || compareMintSwapCreated(left, right)
  );
}
