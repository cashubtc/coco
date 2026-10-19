import type { Keys, Proof, SerializedBlindedSignature } from '@cashu/cashu-ts';
import type { Keyset } from '../../models/Keyset.ts';
import { ProofValidationError } from '../../models/Error.ts';
import { deserializeOutputData } from '../../utils.ts';
import type { ExecutingMeltOperation, PendingMeltOperation } from './MeltOperation.ts';

/** Unblind remote candidates against the immutable blank-output plan; performs no persistence. */
export function unblindMeltChange(
  operation: ExecutingMeltOperation | PendingMeltOperation,
  signatures: SerializedBlindedSignature[],
  keysets: readonly Keyset[],
): Proof[] {
  const outputs = deserializeOutputData(operation.changeOutputData).keep;
  if (signatures.length > outputs.length)
    throw new ProofValidationError('Mint returned more change signatures than allocated outputs');
  return signatures.map((signature, index) => {
    const output = outputs[index];
    const keyset = keysets.find((candidate) => candidate.id === signature.id);
    if (!output || !keyset) throw new ProofValidationError('Melt change keyset is unavailable');
    return output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys });
  });
}
