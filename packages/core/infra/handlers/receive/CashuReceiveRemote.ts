import {
  Amount,
  Mint,
  Wallet,
  sumProofs,
  type Keys,
  type OutputDataLike,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import type {
  ReceiveRemote,
  ReceiveRemoteSession,
} from '@core/operations/receive/ReceiveRemote.ts';
import { computeYHexForSecrets, deserializeOutputData } from '@core/utils.ts';
import type { MintAdapter } from '../../MintAdapter.ts';
import type { MintRequestProvider } from '../../MintRequestProvider.ts';

/** Submits a persisted request through cashu-ts, without selection, signing, or allocation. */
export class CashuReceiveRemote implements ReceiveRemote {
  constructor(
    private readonly auth: Pick<MintAdapter, 'getAuthProvider'>,
    private readonly requests: Pick<MintRequestProvider, 'getRequestFn'>,
  ) {}

  open(metadata: MintMetadata, unit: string): ReceiveRemoteSession {
    const mintUrl = metadata.mint.mintUrl;
    const mint = new Mint(mintUrl, {
      authProvider: this.auth.getAuthProvider(mintUrl),
      customRequest: this.requests.getRequestFn(mintUrl),
    });
    const wallet = new Wallet(mint, { unit });
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, unit, metadata.keysets).cache,
    );
    const unblind = (output: OutputDataLike, signature: SerializedBlindedSignature) => {
      if (
        signature.id !== output.blindedMessage.id ||
        !Amount.from(signature.amount).equals(output.blindedMessage.amount)
      ) {
        throw new ProofValidationError('Receive signature does not match allocated output');
      }
      const keyset = metadata.keysets.find((keyset) => keyset.id === signature.id);
      if (!keyset || normalizeUnit(keyset.unit) !== normalizeUnit(unit)) {
        throw new ProofValidationError('Receive output keyset is missing or has a different unit');
      }
      return output.toProof(signature, { id: keyset.id, keys: keyset.keypairs as Keys });
    };
    return {
      receive: async (request) => {
        if (request.mintUrl !== mintUrl || normalizeUnit(request.unit) !== normalizeUnit(unit)) {
          throw new ProofValidationError('Receive request has a different mint or unit');
        }
        const outputs = deserializeOutputData(request.outputData).keep;
        const keysetId = outputs[0]?.blindedMessage.id;
        if (!keysetId || outputs.some((output) => output.blindedMessage.id !== keysetId)) {
          throw new ProofValidationError('Receive outputs must use a single non-empty keyset');
        }
        const amount = Amount.sum(outputs.map((output) => output.blindedMessage.amount));
        // Complete an already prepared swap. This preserves cashu-ts's established wire sorting
        // and witness normalization for legacy requests without redoing selection or allocation.
        const result = await wallet.completeSwap({
          inputs: request.inputProofs,
          keepOutputs: outputs,
          keysetId,
          amount,
          fees: sumProofs(request.inputProofs).subtract(amount),
        });
        return result.keep;
      },
      checkProofStates: async (proofs) => {
        const ys = computeYHexForSecrets(proofs.map((proof) => proof.secret));
        const states = [];
        for (let offset = 0; offset < ys.length; offset += 100) {
          const batch = ys.slice(offset, offset + 100);
          const result = await mint.check({ Ys: batch });
          if (
            result.states.length !== batch.length ||
            result.states.some(
              (state, i) =>
                state.Y !== batch[i] || !['UNSPENT', 'PENDING', 'SPENT'].includes(state.state),
            )
          ) {
            throw new ProofValidationError('Invalid Receive proof-state evidence');
          }
          states.push(...result.states);
        }
        return states;
      },
      restoreOutputs: async (serialized) => {
        const outputs = deserializeOutputData(serialized).keep;
        const result = await mint.restore({
          outputs: outputs.map((output) => output.blindedMessage),
        });
        if (result.outputs.length !== result.signatures.length)
          throw new ProofValidationError('Mismatched Restore arrays');
        const planned = new Map(outputs.map((output) => [output.blindedMessage.B_, output]));
        const seen = new Set<string>();
        return result.outputs.map((message, index) => {
          const output = planned.get(message.B_);
          if (
            !output ||
            seen.has(message.B_) ||
            message.id !== output.blindedMessage.id ||
            !Amount.from(message.amount).equals(output.blindedMessage.amount)
          ) {
            throw new ProofValidationError('Restore returned an unexpected or duplicate output');
          }
          seen.add(message.B_);
          return unblind(output, result.signatures[index]!);
        });
      },
    };
  }
}
