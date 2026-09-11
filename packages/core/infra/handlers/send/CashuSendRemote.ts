import { Mint, Wallet, type OutputDataCreator, type OutputDataLike } from '@cashu/cashu-ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import type { SendRemote, SendRemoteSession } from '@core/operations/send/SendRemote.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import { deserializeOutputData } from '@core/utils.ts';
import type { MintAdapter } from '../../MintAdapter.ts';
import type { MintRequestProvider } from '../../MintRequestProvider.ts';
import { restoreOutputProofs } from '../../ProofRestore.ts';

/** Protocol effects and unblinding. No Services, repositories, transactions, or event publisher. */
export class CashuSendRemote implements SendRemote {
  constructor(
    private readonly mint: Pick<MintAdapter, 'getAuthProvider'>,
    private readonly requests: Pick<MintRequestProvider, 'getRequestFn'>,
    private readonly outputDataCreator?: OutputDataCreator,
  ) {}

  open(metadata: MintMetadata, unit: string): SendRemoteSession {
    const mintUrl = metadata.mint.mintUrl;
    const wallet = new Wallet(
      new Mint(mintUrl, {
        customRequest: this.requests.getRequestFn(mintUrl),
        authProvider: this.mint.getAuthProvider(mintUrl),
      }),
      { unit, outputDataCreator: this.outputDataCreator },
    );
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, unit, metadata.keysets).cache,
    );
    return {
      swap: (request) => {
        const data = deserializeOutputData(request.outputData);
        const keysetId = getOutputKeysetId([...data.keep, ...data.send]);
        return wallet.send(
          request.amount,
          request.inputProofs,
          { keysetId },
          {
            send: { type: 'custom', data: data.send },
            keep: { type: 'custom', data: data.keep },
          },
        );
      },
      checkProofStates: (proofs) => wallet.checkProofsStates(proofs),
      restoreOutputs: (outputs) => restoreOutputProofs(wallet, metadata.keysets, unit, outputs),
      reclaim: (proofs, outputs) => {
        const data = deserializeOutputData(outputs).keep;
        const keysetId = getOutputKeysetId(data);
        return wallet.receive(
          { mint: mintUrl, proofs, unit },
          { keysetId },
          {
            type: 'custom',
            data,
          },
        );
      },
    };
  }
}

/** Pin unblinding to the committed output plan, even if the wallet now prefers another keyset. */
function getOutputKeysetId(outputs: readonly OutputDataLike[]): string {
  const keysetId = outputs[0]?.blindedMessage.id;
  if (!keysetId || outputs.some((output) => output.blindedMessage.id !== keysetId)) {
    throw new ProofValidationError('Send outputs must specify a single non-empty keyset id');
  }
  return keysetId;
}
