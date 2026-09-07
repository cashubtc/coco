import { Amount, type Proof } from '@cashu/cashu-ts';
import { mock } from 'bun:test';
import type {
  ReceiveRemote,
  ReceiveRemoteSession,
} from '../../operations/receive/ReceiveRemote.ts';
import type { SerializedOutputData } from '../../utils.ts';

export function receivedProofs(outputData: SerializedOutputData): Proof[] {
  return outputData.keep.map((output) => {
    const secret = Buffer.from(output.secret, 'hex').toString();
    return {
      id: output.blindedMessage.id,
      amount: Amount.from(output.blindedMessage.amount),
      secret,
      C: `C_${secret}`,
    };
  });
}

/** Remote behavior is configurable; all durable writes go through the real gateway. */
export function createReceiveRemoteDouble() {
  const session = {
    receive: mock<ReceiveRemoteSession['receive']>(async (request) =>
      receivedProofs(request.outputData),
    ),
    checkProofStates: mock<ReceiveRemoteSession['checkProofStates']>(async (proofs) =>
      proofs.map(() => ({ Y: 'test', witness: null, state: 'UNSPENT' })),
    ),
    observeRestore: mock<ReceiveRemoteSession['observeRestore']>(async (outputs) => ({
      status: 'none',
      expectedOutputCount: outputs.keep.length,
      restoredProofs: [],
      unspentProofs: [],
    })),
  };
  return {
    ...session,
    open: mock<ReceiveRemote['open']>(() => session),
    fetchMintMetadata: mock<ReceiveRemote['fetchMintMetadata']>(async () => {
      throw new Error('Unexpected mint metadata refresh');
    }),
  };
}
