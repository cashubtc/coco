import { Mint, Wallet, normalizeProofAmounts, type OutputDataCreator } from '@cashu/cashu-ts';
import type { MintMetadata } from '@core/mints/MintMetadata.ts';
import { getOutputKeysetId, assertOutputKeysetActive } from '@core/proofs/OutputKeyset.ts';
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
      {
        unit,
        strictCachedKeysets: true,
        outputDataCreator: this.outputDataCreator,
        // Send preparation already committed these inputs. Preserve their order on every replay.
        selectProofs: (proofs) => ({ keep: [], send: normalizeProofAmounts(proofs) }),
      },
    );
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, unit, metadata.keysets).cache,
    );
    return {
      swap: (request) => {
        const data = deserializeOutputData(request.outputData);
        const keysetId = getOutputKeysetId([...data.keep, ...data.send]);
        assertOutputKeysetActive(wallet, keysetId);
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
        assertOutputKeysetActive(wallet, keysetId);
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
