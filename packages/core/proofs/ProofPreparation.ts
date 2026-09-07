import type { Proof } from '@cashu/cashu-ts';
import type { P2pkSigner } from '@core/keypairs/P2pkSigner.ts';
import type { Logger } from '@core/logging/Logger.ts';
import { ProofValidationError } from '@core/models/Error.ts';

/** Validate supported input conditions and sign with existing keys before entering a transaction. */
export async function prepareProofsForReceiving(
  proofs: Proof[],
  signer: P2pkSigner,
  logger?: Logger,
): Promise<Proof[]> {
  logger?.debug('Preparing proofs for receiving', { totalProofs: proofs.length });

  const preparedProofs = [...proofs];
  let regularProofCount = 0;
  let p2pkProofCount = 0;

  for (let i = 0; i < preparedProofs.length; i++) {
    const proof = preparedProofs[i];
    if (!proof) continue;

    // Try to parse as P2PK proof
    let parsedSecret: [string, { nonce: string; data: string; tags: string[][] }];
    try {
      parsedSecret = JSON.parse(proof.secret);
    } catch (parseError) {
      // Not a JSON secret (regular proof), skip P2PK processing
      logger?.debug('Regular proof detected, skipping P2PK processing', {
        proofIndex: i,
      });
      regularProofCount++;
      continue;
    }

    // Check if it's a P2PK proof
    if (parsedSecret[0] !== 'P2PK') {
      logger?.error('Unsupported locking script type', {
        proofIndex: i,
        scriptType: parsedSecret[0],
      });
      throw new ProofValidationError('Only P2PK locking scripts are supported');
    }

    // Validate multisig is not used
    const additionalKeysTag = parsedSecret[1].tags?.find((tag) => tag[0] === 'pubkeys');
    if (additionalKeysTag && additionalKeysTag[1] && additionalKeysTag[1].length > 0) {
      logger?.error('Multisig P2PK proof detected', { proofIndex: i });
      throw new ProofValidationError('Multisig is not supported');
    }

    // Sign the proof - if this fails, we abort the entire operation
    try {
      preparedProofs[i] = await signer.signProof(proof, parsedSecret[1].data);
      logger?.debug('P2PK proof signed successfully', {
        proofIndex: i,
        recipient: parsedSecret[1].data,
      });
      p2pkProofCount++;
    } catch (error) {
      logger?.error('Failed to sign P2PK proof for receiving', {
        proofIndex: i,
        recipient: parsedSecret[1].data,
        error,
      });
      throw error;
    }
  }

  logger?.info('Proofs prepared for receiving', {
    totalProofs: proofs.length,
    regularProofs: regularProofCount,
    p2pkProofs: p2pkProofCount,
  });

  return preparedProofs;
}
