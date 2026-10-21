import {
  Keyset as CashuKeyset,
  Mint,
  isBlsKeyset,
  type CheckStatePayload,
  type Keys,
  type OutputDataLike,
  type Proof,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type MeltQuoteOnchainResponse,
  type MintQuoteBolt11Response,
  type MintQuoteBolt12Response,
  type MintQuoteOnchainResponse,
  type GetKeysetsResponse,
  type MintKeyset,
  type AuthProvider,
} from '@cashu/cashu-ts';
import type { Logger } from '../logging/Logger.ts';
import type { MintInfo } from '../types';
import type { MintRequestProvider } from './MintRequestProvider.ts';
import type { Keyset, KeysetKeypairs } from '../models/Keyset.ts';
import type { MintMetadataObservation } from '../mints/MintMetadata.ts';
import { KeysetSyncError, KeysetVerificationError, MintFetchError } from '../models/Error.ts';
import type { MintMethod } from '../operations/mint/MintMethodHandler.ts';

type NormalizedMintQuoteSnapshot<M extends MintMethod> = M extends 'bolt11'
  ? MintQuoteBolt11Response
  : M extends 'bolt12'
    ? MintQuoteBolt12Response
    : MintQuoteOnchainResponse;

/**
 * Adapter for making HTTP requests to Cashu mints.
 *
 * All requests are rate-limited through the MintRequestProvider,
 * sharing the same rate limits with other components (e.g., WalletService).
 */
export class MintAdapter {
  private cashuMints: Record<string, Mint> = {};
  private readonly requestProvider: MintRequestProvider;
  private readonly authProviders = new Map<string, AuthProvider>();
  private readonly logger?: Logger;

  constructor(requestProvider: MintRequestProvider, logger?: Logger) {
    this.requestProvider = requestProvider;
    this.logger = logger;
  }

  /** Register an AuthProvider for a mint (NUT-21/22). Invalidates the cached Mint instance. */
  setAuthProvider(mintUrl: string, provider: AuthProvider): void {
    this.authProviders.set(mintUrl, provider);
    delete this.cashuMints[mintUrl];
  }

  /** Get the AuthProvider for a mint (if registered). */
  getAuthProvider(mintUrl: string): AuthProvider | undefined {
    return this.authProviders.get(mintUrl);
  }

  /** Remove the AuthProvider for a mint. Invalidates the cached Mint instance. */
  clearAuthProvider(mintUrl: string): void {
    this.authProviders.delete(mintUrl);
    delete this.cashuMints[mintUrl];
  }

  async fetchMintInfo(mintUrl: string): Promise<MintInfo> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.getInfo();
  }

  async fetchKeysets(mintUrl: string): Promise<GetKeysetsResponse> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.getKeySets();
  }

  /**
   * Fetches the keys a mint publishes for one of its advertised keysets.
   *
   * Takes the `/v1/keysets` entry rather than a bare id because a keyset id commits to its keys
   * (NUT-02) and a v2 id also commits to `unit`, `input_fee_ppk` and `final_expiry`. `/v1/keys`
   * omits `final_expiry`, so only the advertised entry can derive the id the keys must match.
   * `Keyset.fromMintApi` reconciles the two responses and `verify` derives the id from the keys,
   * so keys that contradict or do not derive the advertised keyset are rejected.
   */
  async fetchKeysForId(mintUrl: string, keyset: MintKeyset): Promise<KeysetKeypairs> {
    const cashuMint = this.getCashuMint(mintUrl);
    const { keysets } = await cashuMint.getKeys(keyset.id);
    const [fetched] = keysets;
    if (keysets.length !== 1 || !fetched) {
      throw new KeysetVerificationError(
        mintUrl,
        keyset.id,
        `Expected 1 keyset for ${keyset.id}, got ${keysets.length}`,
      );
    }
    let advertised;
    try {
      advertised = CashuKeyset.fromMintApi(keyset, fetched);
    } catch (error) {
      throw new KeysetVerificationError(
        mintUrl,
        keyset.id,
        `Mint served keys that contradict keyset ${keyset.id}`,
        error,
      );
    }
    if (!advertised.verify()) {
      throw new KeysetVerificationError(
        mintUrl,
        keyset.id,
        `Keys returned for keyset ${keyset.id} do not derive its id`,
      );
    }
    return fetched.keys as KeysetKeypairs;
  }

  /** Fetches a metadata observation, reusing known keys without accessing Wallet storage. */
  async fetchMintMetadata(
    mintUrl: string,
    knownKeysets: readonly Keyset[],
  ): Promise<MintMetadataObservation> {
    const observedAt = Math.floor(Date.now() / 1000);
    const mintInfo = await this.fetchMintInfo(mintUrl).catch((error: unknown) => {
      throw new MintFetchError(mintUrl, undefined, error);
    });
    const result = await this.fetchKeysets(mintUrl).catch((error: unknown) => {
      throw new MintFetchError(mintUrl, 'Failed to fetch keysets', error);
    });
    const observed = await Promise.all(
      result.keysets
        .filter((keyset) => !isBlsKeyset(keyset.id))
        .map(async (keyset) => {
          const known = knownKeysets.find((candidate) => candidate.id === keyset.id);
          // Stored keys are reused only while they still derive the advertised entry. A keyset
          // recorded without keys fails this, and so does one whose advertised unit, fee or
          // expiry changed, which an `01`-prefixed id commits to and so cannot change under it.
          const keypairs =
            known && CashuKeyset.verifyKeysetId({ ...keyset, keys: known.keypairs as Keys })
              ? known.keypairs
              : await this.fetchKeysForId(mintUrl, keyset).catch((error: unknown) => {
                  // Refusing one keyset's keys must not cost the Wallet the keysets that did
                  // verify, or one bad keyset makes every balance at this mint unreachable.
                  if (error instanceof KeysetVerificationError) {
                    this.logger?.warn('Skipping keyset whose keys failed NUT-02 verification', {
                      mintUrl,
                      keysetId: keyset.id,
                      error,
                    });
                    return null;
                  }
                  if (error instanceof KeysetSyncError) throw error;
                  throw new KeysetSyncError(mintUrl, keyset.id, undefined, error);
                });
          if (keypairs === null) return null;
          return {
            mintUrl,
            id: keyset.id,
            unit: keyset.unit,
            active: keyset.active,
            feePpk: keyset.input_fee_ppk || 0,
            keypairs,
          };
        }),
    );
    const keysets = observed.filter((keyset) => keyset !== null);
    return { mintUrl, mintInfo, keysets, observedAt };
  }

  private getCashuMint(mintUrl: string): Mint {
    if (!this.cashuMints[mintUrl]) {
      const requestFn = this.requestProvider.getRequestFn(mintUrl);
      const authProvider = this.authProviders.get(mintUrl);
      this.cashuMints[mintUrl] = new Mint(mintUrl, { customRequest: requestFn, authProvider });
    }
    return this.cashuMints[mintUrl];
  }

  async checkMintQuote<M extends MintMethod>(
    mintUrl: string,
    method: M,
    quoteId: string,
  ): Promise<NormalizedMintQuoteSnapshot<M>> {
    const cashuMint = this.getCashuMint(mintUrl);
    return cashuMint.checkMintQuote<NormalizedMintQuoteSnapshot<M>>(method, quoteId);
  }

  /** Send one NUT-29 mint-quote batch check through the shared auth and rate-limit boundary. */
  async checkMintQuoteBatch<M extends MintMethod>(
    mintUrl: string,
    method: M,
    quoteIds: string[],
  ): Promise<NormalizedMintQuoteSnapshot<M>[]> {
    return this.getCashuMint(mintUrl).checkMintQuoteBatch<NormalizedMintQuoteSnapshot<M>>(
      method,
      quoteIds,
    );
  }

  // Check current state of a bolt11 melt quote (returns full response including change)
  async checkMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuoteBolt11Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.checkMeltQuoteBolt11(quoteId);
  }

  // Check current state of a bolt12 melt quote (returns full response including change)
  async checkMeltQuoteBolt12(mintUrl: string, quoteId: string): Promise<MeltQuoteBolt12Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.checkMeltQuoteBolt12(quoteId);
  }

  // Check current state of an onchain melt quote (returns full response including change/outpoint)
  async checkMeltQuoteOnchain(mintUrl: string, quoteId: string): Promise<MeltQuoteOnchainResponse> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.checkMeltQuoteOnchain(quoteId);
  }

  // Check current state of a bolt11 melt quote (returns only state)
  async checkMeltQuoteState(
    mintUrl: string,
    quoteId: string,
  ): Promise<MeltQuoteBolt11Response['state']> {
    const res = await this.checkMeltQuote(mintUrl, quoteId);
    return res.state;
  }

  // Check current state of a bolt12 melt quote (returns only state)
  async checkMeltQuoteBolt12State(
    mintUrl: string,
    quoteId: string,
  ): Promise<MeltQuoteBolt12Response['state']> {
    const res = await this.checkMeltQuoteBolt12(mintUrl, quoteId);
    return res.state;
  }

  // Check current state of an onchain melt quote (returns only state)
  async checkMeltQuoteOnchainState(
    mintUrl: string,
    quoteId: string,
  ): Promise<MeltQuoteOnchainResponse['state']> {
    const res = await this.checkMeltQuoteOnchain(mintUrl, quoteId);
    return res.state;
  }

  // Batch check of proof states by Y values (up to 100 per request)
  async checkProofStates(mintUrl: string, Ys: string[]) {
    const cashuMint = this.getCashuMint(mintUrl);
    const payload: CheckStatePayload = { Ys };
    const response = await cashuMint.check(payload);
    return response.states;
  }

  async customMeltBolt11(
    mintUrl: string,
    proofsToSend: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<MeltQuoteBolt11Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    const blindedMessages = changeOutputs.map((output) => output.blindedMessage);
    return cashuMint.meltBolt11({ quote: quoteId, inputs: proofsToSend, outputs: blindedMessages });
  }

  async customMeltBolt12(
    mintUrl: string,
    proofsToSend: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
  ): Promise<MeltQuoteBolt12Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    const blindedMessages = changeOutputs.map((output) => output.blindedMessage);
    return cashuMint.meltBolt12({ quote: quoteId, inputs: proofsToSend, outputs: blindedMessages });
  }

  async customMeltOnchain(
    mintUrl: string,
    proofsToSend: Proof[],
    changeOutputs: OutputDataLike[],
    quoteId: string,
    feeIndex: number,
  ): Promise<MeltQuoteOnchainResponse> {
    const cashuMint = this.getCashuMint(mintUrl);
    const blindedMessages = changeOutputs.map((output) => output.blindedMessage);
    return cashuMint.meltOnchain({
      quote: quoteId,
      inputs: proofsToSend,
      outputs: blindedMessages,
      fee_index: feeIndex,
      prefer_async: true,
    });
  }
}
