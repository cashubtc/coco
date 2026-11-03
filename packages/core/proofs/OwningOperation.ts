import type { CoreProof } from '@core/types.ts';
import type {
  MeltOperationRepository,
  MintOperationRepository,
  ReceiveOperationRepository,
  SendOperationRepository,
} from '@core/repositories';
import { isTerminalOperation as isTerminalMelt } from '../operations/melt/MeltOperation.ts';
import { isTerminalOperation as isTerminalMint } from '../operations/mint/MintOperation.ts';
import { isMintSwapTerminalState } from '../operations/mintSwap/MintSwapOperation.ts';
import type { MintSwapOperationRepository } from '../operations/mintSwap/MintSwapOperationRepository.ts';
import { isTerminalOperation as isTerminalReceive } from '../operations/receive/ReceiveOperation.ts';
import { isTerminalOperation as isTerminalSend } from '../operations/send/SendOperation.ts';

type OperationReferences = Pick<CoreProof, 'usedByOperationId' | 'createdByOperationId'>;

/** A live operation that owns a proof, by the operation type that decides its state. */
export type OwningOperation = {
  [Kind in OwningOperationKind]: { kind: Kind; operationId: string };
}[OwningOperationKind];

type OwningOperationKind = 'send' | 'melt' | 'mint' | 'receive' | 'mintSwap';

/** Operation lookups needed to resolve ownership; a CoreTransaction satisfies this. */
export interface OwningOperationReads {
  readonly sendOperations: Pick<SendOperationRepository, 'getById'>;
  readonly meltOperations: Pick<MeltOperationRepository, 'getById'>;
  readonly mintOperations: Pick<MintOperationRepository, 'getById'>;
  readonly receiveOperations: Pick<ReceiveOperationRepository, 'getById'>;
  readonly mintSwapOperations: Pick<MintSwapOperationRepository, 'getById'>;
}

/** Live operations by id, shared within one pass; undefined marks a missing or terminal one. */
export type OwningOperationCache = Map<string, Promise<OwningOperation | undefined>>;

/** Whether the proof record references any operation, live or not. */
export function hasOperationReference(proof: OperationReferences): boolean {
  return proof.usedByOperationId != null || proof.createdByOperationId != null;
}

/**
 * Resolve a proof's Owning Operation: the reserving operation if it is live, else the creating one
 * if it is live. Missing and terminal operations own nothing, so such a proof is unowned.
 */
export async function resolveOwningOperation(
  reads: OwningOperationReads,
  proof: OperationReferences,
  cache: OwningOperationCache = new Map(),
): Promise<OwningOperation | undefined> {
  for (const operationId of [proof.usedByOperationId, proof.createdByOperationId]) {
    if (!operationId) continue;
    let live = cache.get(operationId);
    if (!live) {
      live = findLiveOperation(reads, operationId);
      cache.set(operationId, live);
    }
    const owningOperation = await live;
    if (owningOperation) return owningOperation;
  }
  return undefined;
}

async function findLiveOperation(
  reads: OwningOperationReads,
  operationId: string,
): Promise<OwningOperation | undefined> {
  const send = await reads.sendOperations.getById(operationId);
  if (send) return isTerminalSend(send) ? undefined : { kind: 'send', operationId };
  const melt = await reads.meltOperations.getById(operationId);
  if (melt) return isTerminalMelt(melt) ? undefined : { kind: 'melt', operationId };
  const mint = await reads.mintOperations.getById(operationId);
  if (mint) return isTerminalMint(mint) ? undefined : { kind: 'mint', operationId };
  const receive = await reads.receiveOperations.getById(operationId);
  if (receive) return isTerminalReceive(receive) ? undefined : { kind: 'receive', operationId };
  const mintSwap = await reads.mintSwapOperations.getById(operationId);
  if (mintSwap) {
    return isMintSwapTerminalState(mintSwap.state) ? undefined : { kind: 'mintSwap', operationId };
  }
  return undefined;
}
