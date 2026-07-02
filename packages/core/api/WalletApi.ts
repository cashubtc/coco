import {
  getEncodedToken,
  getTokenMetadata,
  type PaymentRequest,
  type Token,
} from '@cashu/cashu-ts';
import type {
  MintService,
  WalletService,
  ProofService,
  WalletRestoreService,
  TokenService,
} from '@core/services';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type {
  DeferredReceiveOperation,
  FinalizedReceiveOperation,
} from '../operations/receive/ReceiveOperation';
import type { Logger } from '../logging/Logger.ts';
import { WalletBalancesApi } from './WalletBalancesApi.ts';
import { DEFAULT_UNIT, normalizeUnit, normalizeUnitList } from '../amounts.ts';

export interface WalletRestoreOptions {
  /**
   * Optional unit filter. Units are normalized to lowercase.
   * Omit this to restore every keyset unit known by the mint.
   */
  units?: string[];
}

export interface WalletSweepOptions {
  /**
   * Optional unit filter. Units are normalized to lowercase.
   * Omit this to sweep every keyset unit known by the mint.
   */
  units?: string[];
}

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private receiveOperationService: ReceiveOperationService;
  private readonly tokenService: TokenService;
  private readonly logger?: Logger;
  readonly balances: WalletBalancesApi;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    walletRestoreService: WalletRestoreService,
    receiveOperationService: ReceiveOperationService,
    tokenService: TokenService,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.walletRestoreService = walletRestoreService;
    this.receiveOperationService = receiveOperationService;
    this.tokenService = tokenService;
    this.logger = logger;
    this.balances = new WalletBalancesApi(proofService);
  }

  /**
   * Receive a token in one shot.
   *
   * Returns the finalized operation, or a deferred operation when the receive
   * cannot be settled yet (dust below the swap fee, missing p2pk key, or an
   * unreachable mint); deferred receives are redeemed later, batched with other
   * queued proofs of the same mint and unit.
   *
   * For a multi-step receive flow (review fees/amounts before committing),
   * use `manager.ops.receive.prepare()` and `manager.ops.receive.execute()`.
   */
  async receive(
    token: Token | string,
  ): Promise<FinalizedReceiveOperation | DeferredReceiveOperation> {
    return this.receiveOperationService.receive(token);
  }

  // Restoration logic is delegated to WalletRestoreService

  async restore(mintUrl: string, options?: WalletRestoreOptions) {
    this.logger?.info('Starting restore', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for restore', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const unitFilter = this.getUnitFilter(options?.units);
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const { keyset, unit } of this.getUnitScopedKeysets(mint.keysets, unitFilter)) {
      try {
        const wallet = await this.walletService.getWallet(mintUrl, unit);
        await this.walletRestoreService.restoreKeyset(mintUrl, wallet, keyset.id, unit);
      } catch (error) {
        this.logger?.error('Keyset restore failed', {
          mintUrl,
          keysetId: keyset.id,
          unit,
          error,
        });
        failedKeysetIds[keyset.id] = error as Error;
      }
    }
    if (Object.keys(failedKeysetIds).length > 0) {
      this.logger?.error('Restore completed with failures', {
        mintUrl,
        failedKeysetIds: Object.keys(failedKeysetIds),
      });
      throw new Error('Failed to restore some keysets');
    }
    this.logger?.info('Restore completed successfully', { mintUrl });
  }

  /**
   * Sweeps a mint by sweeping each keyset and adds the swept proofs to the wallet
   * @param mintUrl - The URL of the mint to sweep
   * @param bip39seed - The BIP39 seed of the wallet to sweep
   */
  async sweep(mintUrl: string, bip39seed: Uint8Array, options?: WalletSweepOptions) {
    this.logger?.info('Starting sweep', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for sweep', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const unitFilter = this.getUnitFilter(options?.units);
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const { keyset, unit } of this.getUnitScopedKeysets(mint.keysets, unitFilter)) {
      try {
        await this.walletRestoreService.sweepKeyset(mintUrl, keyset.id, bip39seed, unit);
      } catch (error) {
        this.logger?.error('Keyset restore failed', { mintUrl, keysetId: keyset.id, unit, error });
        failedKeysetIds[keyset.id] = error as Error;
      }
    }
    if (Object.keys(failedKeysetIds).length > 0) {
      this.logger?.error('Restore completed with failures', {
        mintUrl,
        failedKeysetIds: Object.keys(failedKeysetIds),
      });
      throw new Error('Failed to restore some keysets');
    }
    this.logger?.info('Restore completed successfully', { mintUrl });
  }

  /**
   * Decode a token string into a Token object.
   * If mintUrl is provided, decodes token with mint keysets (supports all token formats).
   * If no mintUrl, attempts to decode using wallet's known keysets (may fail for some token formats).
   *
   * Note: For reliable decoding of all token formats, provide a mintUrl.
   *
   * @param tokenString - The encoded token string to decode
   * @param mintUrl - Optional mint URL to use for decoding (provides access to mint keysets for decoding)
   * @returns The decoded Token or array of Proofs
   */
  async decodeToken(tokenString: string, mintUrl?: string): Promise<Token> {
    if (mintUrl) {
      return await this.tokenService.decodeToken(tokenString, mintUrl);
    }

    const metadata = getTokenMetadata(tokenString);
    return this.tokenService.decodeToken(tokenString, metadata.mint);
  }

  /**
   * Encode a token to a string.
   * @param token - The token to encode
   * @param opts - Optional encoding options
   * @returns Encoded token string
   */
  encodeToken(token: Token, opts?: { removeDleq?: boolean }): string {
    return getEncodedToken(token, opts);
  }

  /**
   * Encode a PaymentRequest to a string.
   * @param paymentRequest - The PaymentRequest to encode
   * @param version - Encoding version ('creqA' for base64 text, 'creqB' for bech32m binary). Defaults to 'creqA'.
   * @returns Encoded payment request string
   */
  encodePaymentRequest(paymentRequest: PaymentRequest, version?: 'creqA' | 'creqB'): string {
    if (version === 'creqB') {
      return paymentRequest.toEncodedCreqB();
    }
    return paymentRequest.toEncodedCreqA();
  }

  private getUnitFilter(units?: string[]): Set<string> | undefined {
    const normalizedUnits = normalizeUnitList(units);
    return normalizedUnits ? new Set(normalizedUnits) : undefined;
  }

  private getUnitScopedKeysets<T extends { id: string; unit?: string | null }>(
    keysets: T[],
    unitFilter?: Set<string>,
  ): Array<{ keyset: T; unit: string }> {
    return keysets
      .map((keyset) => ({
        keyset,
        unit: normalizeUnit(keyset.unit ?? DEFAULT_UNIT, { defaultUnit: DEFAULT_UNIT }),
      }))
      .filter(({ unit }) => !unitFilter || unitFilter.has(unit));
  }
}
