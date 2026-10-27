import type { Proof } from '@cashu/cashu-ts';
import type { P2pkSigner } from '@core/keypairs/P2pkSigner.ts';
import { ProofValidationError } from '@core/models/Error.ts';

/** Prepare witnesses with existing keys, before opening a Wallet transaction. */
export async function prepareProofsForReceiving(
  proofs: readonly Proof[],
  signer: P2pkSigner,
): Promise<Proof[]> {
  const prepared: Proof[] = [];
  for (const proof of proofs) {
    let script: unknown;
    try {
      script = JSON.parse(proof.secret);
    } catch {
      prepared.push({ ...proof, witness: undefined });
      continue;
    }
    if (!Array.isArray(script) || script[0] !== 'P2PK') {
      throw new ProofValidationError('Only P2PK locking scripts are supported');
    }
    const condition = script[1];
    if (!condition || typeof condition.data !== 'string') {
      throw new ProofValidationError('Invalid P2PK spending condition');
    }
    const tags: unknown = condition.tags;
    if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => !Array.isArray(tag)))) {
      throw new ProofValidationError('Invalid P2PK tags');
    }
    if (Array.isArray(tags) && tags.some((tag) => tag[0] === 'pubkeys' && tag[1])) {
      throw new ProofValidationError('Multisig is not supported');
    }
    prepared.push(await signer.signProof(proof, condition.data));
  }
  return prepared;
}
