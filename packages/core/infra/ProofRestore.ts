import type { Keys, Proof, Wallet } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import { deserializeOutputData, type SerializedOutputData } from '@core/utils.ts';

/** Remote restoration and local unblinding only. The owning workflow persists candidate proofs. */
export async function restoreOutputProofs(
  wallet: Pick<Wallet, 'mint' | 'checkProofsStates'>,
  keysets: readonly Keyset[],
  unit: string,
  serialized: SerializedOutputData,
  options: { requireComplete?: boolean } = {},
): Promise<Proof[]> {
  const outputData = deserializeOutputData(serialized);
  const outputs = [...outputData.keep, ...outputData.send];
  if (outputs.length === 0) return [];
  const result = await wallet.mint.restore({
    outputs: outputs.map((output) => output.blindedMessage),
  });
  // Batch recovery may fail on an empty response. Never let filtered/invalid signatures look
  // like evidence of absence; other callers retain their existing partial-restoration behavior.
  if (options.requireComplete) {
    if (result.outputs.length === 0 && result.signatures.length === 0) return [];
    if (
      result.outputs.length !== outputs.length ||
      result.signatures.length !== outputs.length ||
      new Set(result.outputs.map((output) => output.B_)).size !== outputs.length
    )
      throw new ProofValidationError('Restore returned an incomplete or duplicate output set');
  }
  const restored: Proof[] = [];
  for (let i = 0; i < result.outputs.length; i++) {
    const output = outputs.find(
      (candidate) => candidate.blindedMessage.B_ === result.outputs[i]?.B_,
    );
    const signature = result.signatures[i];
    if (!output || !signature) {
      if (options.requireComplete)
        throw new ProofValidationError(
          'Restore returned an unexpected output or missing signature',
        );
      continue;
    }
    const keyset = keysets.find((candidate) => candidate.id === signature.id);
    if (
      options.requireComplete &&
      (signature.id !== output.blindedMessage.id ||
        !signature.amount.equals(output.blindedMessage.amount))
    )
      throw new ProofValidationError('Restore signature does not match the persisted output');
    if (!keyset) {
      if (options.requireComplete)
        throw new ProofValidationError('Restore returned an unknown keyset');
      continue;
    }
    assertSameUnit(normalizeUnit(keyset.unit), normalizeUnit(unit), 'Restored proof keyset');
    restored.push(output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys }));
  }
  if (restored.length === 0) return [];
  const states = await wallet.checkProofsStates(restored);
  if (
    options.requireComplete &&
    (states.length !== restored.length || states.some((state) => state.state !== 'UNSPENT'))
  )
    throw new ProofValidationError('Restored outputs are not all confirmed unspent');
  return restored.filter((_, index) => states[index]?.state === 'UNSPENT');
}
