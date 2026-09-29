import { Amount, sumProofs } from '@cashu/cashu-ts';
import type {
  PendingSendOperation,
  PreparedSendOperation,
} from '../../operations/send/SendOperation.ts';
import type { CoreProof } from '../../types.ts';

/** Construct persisted request data without invoking the transition under test. */
export function preparedSend(
  id: string,
  inputs: CoreProof[],
  sendProofs?: CoreProof[],
): PreparedSendOperation {
  const { mintUrl, unit } = inputs[0]!;
  return {
    id,
    state: 'prepared',
    mintUrl,
    unit,
    amount: sumProofs(sendProofs ?? inputs),
    method: 'default',
    methodData: sendProofs ? { forceSwap: true } : {},
    createdAt: 100,
    updatedAt: 200,
    revision: 0,
    needsSwap: sendProofs !== undefined,
    fee: Amount.zero(),
    inputAmount: sumProofs(inputs),
    inputProofSecrets: inputs.map((proof) => proof.secret),
    outputData: sendProofs
      ? {
          keep: [],
          send: sendProofs.map((proof) => ({
            blindedMessage: {
              amount: proof.amount.toNumber(),
              id: proof.id,
              B_: `B-${proof.secret}`,
            },
            blindingFactor: '01',
            secret: Buffer.from(proof.secret).toString('hex'),
          })),
        }
      : undefined,
  };
}

export function pendingSend(
  id: string,
  inputs: CoreProof[],
  sendProofs?: CoreProof[],
): PendingSendOperation {
  const prepared = preparedSend(id, inputs, sendProofs);
  return {
    ...prepared,
    state: 'pending',
    revision: sendProofs ? 2 : 1,
    token: { mint: prepared.mintUrl, unit: prepared.unit, proofs: sendProofs ?? inputs },
  };
}
