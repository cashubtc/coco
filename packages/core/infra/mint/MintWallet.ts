import { Mint, Wallet, type OutputDataCreator } from '@cashu/cashu-ts';
import type { MintMetadata } from '../../mints/MintMetadata.ts';
import { createKeyChain } from '../../proofs/KeysetSelection.ts';
import { normalizeUnit } from '../../amounts.ts';
import type { MintAdapter } from '../MintAdapter.ts';
import type { MintRequestProvider } from '../MintRequestProvider.ts';

/** Builds an SDK wallet from a supplied snapshot; construction never fetches or writes metadata. */
export class MintWalletFactory {
  constructor(
    private readonly mint: Pick<MintAdapter, 'getAuthProvider'>,
    private readonly requests: Pick<MintRequestProvider, 'getRequestFn'>,
    private readonly outputs?: OutputDataCreator,
  ) {}

  create(metadata: MintMetadata, unit: string): Wallet {
    unit = normalizeUnit(unit);
    const mintUrl = metadata.mint.mintUrl;
    const wallet = new Wallet(
      new Mint(mintUrl, {
        customRequest: this.requests.getRequestFn(mintUrl),
        authProvider: this.mint.getAuthProvider(mintUrl),
      }),
      { unit, outputDataCreator: this.outputs },
    );
    wallet.loadMintFromCache(
      metadata.mint.mintInfo,
      createKeyChain(mintUrl, unit, metadata.keysets).cache,
    );
    return wallet;
  }
}
