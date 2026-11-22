import type { Proof } from '@cashu/cashu-ts';
import type { P2pkSigner } from '@core/keypairs/P2pkSigner.ts';
import { getReceiveSigningKeys } from './P2pkReceiveValidation.ts';

/** Prepare witnesses with existing keys, before opening a Wallet transaction. */
export async function prepareProofsForReceiving(
  proofs: readonly Proof[],
  signer: P2pkSigner,
): Promise<Proof[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const prepared: Proof[] = [];
  for (const proof of proofs) {
    const signingKeys = getReceiveSigningKeys(proof.secret, nowSeconds);
    if (signingKeys.length === 0) {
      prepared.push({ ...proof, witness: undefined });
      continue;
    }
    prepared.push(await signer.signProof(proof, signingKeys[0]!, signingKeys.slice(1)));
  }
  return prepared;
}
