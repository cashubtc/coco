import {
  Mint,
  type CheckStatePayload,
  OutputData,
  type Proof,
  type MeltQuoteBolt11Response,
  type MeltQuoteBolt12Response,
  type GetKeysetsResponse,
} from '@cashu/cashu-ts';
import type { MintInfo } from '../types';
import type { MintRequestProvider } from './MintRequestProvider.ts';

/**
 * Adapter for making HTTP requests to Cashu mints.
 *
 * All requests are rate-limited through the MintRequestProvider,
 * sharing the same rate limits with other components (e.g., WalletService).
 */
export class MintAdapter {
  private cashuMints: Record<string, Mint> = {};
  private readonly requestProvider: MintRequestProvider;

  constructor(requestProvider: MintRequestProvider) {
    this.requestProvider = requestProvider;
  }

  async fetchMintInfo(mintUrl: string): Promise<MintInfo> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.getInfo();
  }

  async fetchKeysets(mintUrl: string): Promise<GetKeysetsResponse> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.getKeySets();
  }

  async fetchKeysForId(mintUrl: string, id: string): Promise<Record<number, string>> {
    const cashuMint = this.getCashuMint(mintUrl);
    const { keysets } = await cashuMint.getKeys(id);
    if (keysets.length !== 1 || !keysets[0]) {
      throw new Error(`Expected 1 keyset for ${id}, got ${keysets.length}`);
    }
    return keysets[0].keys;
  }

  private getCashuMint(mintUrl: string): Mint {
    if (!this.cashuMints[mintUrl]) {
      const requestFn = this.requestProvider.getRequestFn(mintUrl);
      this.cashuMints[mintUrl] = new Mint(mintUrl, { customRequest: requestFn });
    }
    return this.cashuMints[mintUrl];
  }

  // Check current state of a bolt11 mint quote
  async checkMintQuoteState(mintUrl: string, quoteId: string): Promise<unknown> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.checkMintQuoteBolt11(quoteId);
  }

  // Check current state of a bolt11 melt quote (returns full response including change)
  async checkMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuoteBolt11Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    return await cashuMint.checkMeltQuoteBolt11(quoteId);
  }

  // Check current state of a bolt11 melt quote (returns only state)
  async checkMeltQuoteState(mintUrl: string, quoteId: string): Promise<MeltQuoteBolt11Response['state']> {
    const res = await this.checkMeltQuote(mintUrl, quoteId);
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
    changeOutputs: OutputData[],
    quoteId: string,
  ): Promise<MeltQuoteBolt11Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    const blindedMessages = changeOutputs.map((output) => output.blindedMessage);
    return cashuMint.meltBolt11({ quote: quoteId, inputs: proofsToSend, outputs: blindedMessages });
  }

  async customMeltBolt12(
    mintUrl: string,
    proofsToSend: Proof[],
    changeOutputs: OutputData[],
    quoteId: string,
  ): Promise<MeltQuoteBolt12Response> {
    const cashuMint = this.getCashuMint(mintUrl);
    const blindedMessages = changeOutputs.map((output) => output.blindedMessage);
    return cashuMint.meltBolt12({ quote: quoteId, inputs: proofsToSend, outputs: blindedMessages });
  }
}
