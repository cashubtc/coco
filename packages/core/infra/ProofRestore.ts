import type { Keys, Proof, Wallet } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import type { RestoreProofsObservation } from '@core/proofs/RestoreProofsObservation.ts';
import { deserializeOutputData, type SerializedOutputData } from '@core/utils.ts';

/** Remote restoration and local unblinding only. The owning workflow persists candidate proofs. */
export async function observeOutputProofs(
  wallet: Pick<Wallet, 'mint' | 'checkProofsStates'>,
  keysets: readonly Keyset[],
  unit: string,
  serialized: SerializedOutputData,
): Promise<RestoreProofsObservation> {
  const outputData = deserializeOutputData(serialized);
  const outputs = [...outputData.keep, ...outputData.send];
  const empty = { expectedOutputCount: outputs.length, restoredProofs: [], unspentProofs: [] };
  if (outputs.length === 0) return { ...empty, status: 'none' };
  const result = await wallet.mint.restore({
    outputs: outputs.map((output) => output.blindedMessage),
  });
  const restored: Proof[] = [];
  const matched = new Set<string>();
  for (let i = 0; i < result.outputs.length; i++) {
    const output = outputs.find(
      (candidate) => candidate.blindedMessage.B_ === result.outputs[i]?.B_,
    );
    const signature = result.signatures[i];
    if (!output || !signature || matched.has(output.blindedMessage.B_)) continue;
    const keyset = keysets.find((candidate) => candidate.id === signature.id);
    if (!keyset) continue;
    assertSameUnit(normalizeUnit(keyset.unit), normalizeUnit(unit), 'Restored proof keyset');
    restored.push(output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys }));
    matched.add(output.blindedMessage.B_);
  }
  if (restored.length === 0) {
    return {
      ...empty,
      status:
        result.outputs.length === 0 && result.signatures.length === 0 ? 'none' : 'inconclusive',
    };
  }
  const states = await wallet.checkProofsStates(restored);
  const unspent = restored.filter((_, index) => states[index]?.state === 'UNSPENT');
  const complete = restored.length === outputs.length && states.length === restored.length;
  const allUnspent = complete && states.every((state) => state?.state === 'UNSPENT');
  const allSpent = complete && states.every((state) => state?.state === 'SPENT');
  return {
    status: allUnspent ? 'complete-unspent' : allSpent ? 'complete-spent' : 'inconclusive',
    expectedOutputCount: outputs.length,
    restoredProofs: restored,
    unspentProofs: unspent,
  };
}

/** Existing Send/Restore callers consume only the unspent projection of the same observation. */
export async function restoreOutputProofs(
  wallet: Pick<Wallet, 'mint' | 'checkProofsStates'>,
  keysets: readonly Keyset[],
  unit: string,
  serialized: SerializedOutputData,
): Promise<Proof[]> {
  return (await observeOutputProofs(wallet, keysets, unit, serialized)).unspentProofs;
}
