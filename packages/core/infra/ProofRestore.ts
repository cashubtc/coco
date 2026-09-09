import type { Keys, Proof, Wallet } from '@cashu/cashu-ts';
import { assertSameUnit, normalizeUnit } from '@core/amounts.ts';
import type { Keyset } from '@core/models/Keyset.ts';
import { deserializeOutputData, type SerializedOutputData } from '@core/utils.ts';

/** Remote restoration and local unblinding only. The owning workflow persists candidate proofs. */
export async function restoreOutputProofs(
  wallet: Pick<Wallet, 'mint' | 'checkProofsStates'>,
  keysets: readonly Keyset[],
  unit: string,
  serialized: SerializedOutputData,
): Promise<Proof[]> {
  const outputData = deserializeOutputData(serialized);
  const outputs = [...outputData.keep, ...outputData.send];
  if (outputs.length === 0) return [];
  const result = await wallet.mint.restore({
    outputs: outputs.map((output) => output.blindedMessage),
  });
  const restored: Proof[] = [];
  for (let i = 0; i < result.outputs.length; i++) {
    const output = outputs.find(
      (candidate) => candidate.blindedMessage.B_ === result.outputs[i]?.B_,
    );
    const signature = result.signatures[i];
    if (!output || !signature) continue;
    const keyset = keysets.find((candidate) => candidate.id === signature.id);
    if (!keyset) continue;
    assertSameUnit(normalizeUnit(keyset.unit), normalizeUnit(unit), 'Restored proof keyset');
    restored.push(output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys }));
  }
  if (restored.length === 0) return [];
  const states = await wallet.checkProofsStates(restored);
  return restored.filter((_, index) => states[index]?.state === 'UNSPENT');
}
