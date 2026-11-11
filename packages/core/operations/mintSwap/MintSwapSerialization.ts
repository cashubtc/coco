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

/**
 * Serialize a validated Mint Swap record without losing integer Amount precision.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function serializeMintSwapOperation(operation: MintSwapOperation): string {
  return JSON.stringify(transformAmounts(parseMintSwapOperation(operation), true));
}

/**
 * Hydrate an untrusted stored record through the authoritative parser.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function deserializeMintSwapOperation(recordJson: string): MintSwapOperation {
  return parseMintSwapOperation(transformAmounts(JSON.parse(recordJson), false));
}

export function compareMintSwapIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Order stored Mint Swap Operations by creation time, then identity.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function compareMintSwapCreated(left: MintSwapOperation, right: MintSwapOperation): number {
  return left.createdAt - right.createdAt || compareMintSwapIds(left.id, right.id);
}

/**
 * Order stored Mint Swap Operations by retry time, creation time, then identity.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function compareMintSwapDue(left: MintSwapOperation, right: MintSwapOperation): number {
  return (
    left.retry.nextAttemptAt! - right.retry.nextAttemptAt! || compareMintSwapCreated(left, right)
  );
}
