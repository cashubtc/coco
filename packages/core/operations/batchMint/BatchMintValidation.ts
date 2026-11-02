import { normalizeMintUrl } from '../../utils.ts';
import type { BatchMintOperation } from './BatchMintOperation.ts';

/**
 * Validate the persisted shape every adapter must enforce before writing: at least one member,
 * unique nonnegative integer ordinals, unique Quote Identities and positive member amounts.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function assertBatchMintOperation(operation: BatchMintOperation): void {
  const { id, members } = operation;
  if (members.length === 0) throw new Error(`Batch Mint Operation ${id} has no members`);
  const ordinals = new Set<number>();
  const quoteIds = new Set<string>();
  for (const member of members) {
    if (!Number.isSafeInteger(member.ordinal) || member.ordinal < 0)
      throw new Error(`Batch Mint Operation ${id} has an invalid member ordinal`);
    if (ordinals.has(member.ordinal))
      throw new Error(`Batch Mint Operation ${id} has duplicate ordinal ${member.ordinal}`);
    if (quoteIds.has(member.quoteId))
      throw new Error(`Batch Mint Operation ${id} has duplicate quote ${member.quoteId}`);
    if (member.amount.isZero())
      throw new Error(`Batch Mint Operation ${id} has a zero member amount`);
    ordinals.add(member.ordinal);
    quoteIds.add(member.quoteId);
  }
}

/**
 * Validate an update against the stored operation. Membership, amounts, outputs, quote keys and
 * other request material never change; only `executing` may move to another state.
 *
 * @remarks
 * Unstable repository contract starting with v3: minor or major releases may introduce
 * breaking changes with adapter migration notes. Patch releases preserve compatibility.
 *
 * @see {@link https://github.com/cashubtc/coco/blob/master/packages/core/README.md#repository-compatibility | Repository compatibility policy}
 */
export function assertBatchMintUpdate(current: BatchMintOperation, next: BatchMintOperation): void {
  assertBatchMintOperation(next);
  if (current.id !== next.id) throw new Error('Batch Mint update must keep the operation ID');
  if (requestKey(current) !== requestKey(next))
    throw new Error(`Batch Mint Operation ${current.id} request material is immutable`);
  if (current.state !== 'executing' && next.state !== current.state)
    throw new Error(
      `Cannot move Batch Mint Operation ${current.id} from ${current.state} to ${next.state}`,
    );
}

function requestKey(operation: BatchMintOperation): string {
  return JSON.stringify([
    normalizeMintUrl(operation.mintUrl),
    operation.method,
    operation.unit,
    operation.createdAt,
    [...operation.members]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((member) => [
        member.ordinal,
        member.quoteId,
        member.amount.toString(),
        member.request,
        member.pubkey,
      ]),
    operation.outputData,
  ]);
}
