import {
  getEncodedToken,
  getTokenMetadata,
  type PaymentRequest,
  type Token,
} from '@cashu/cashu-ts';
import type {
  MintService,
  WalletService,
  WalletRestoreService,
  TokenService,
} from '@core/services';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type { Logger } from '../logging/Logger.ts';
import type { BalanceQueries } from '../proofs/BalanceQueries.ts';
import { WalletBalancesApi } from './WalletBalancesApi.ts';
import type { SweepReport } from '../models/Sweep.ts';
import { normalizeMintUrl } from '../utils.ts';
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
  private walletRestoreService: WalletRestoreService;
  private receiveOperationService: ReceiveOperationService;
  private readonly tokenService: TokenService;
  private readonly logger?: Logger;
  readonly balances: WalletBalancesApi;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    walletRestoreService: WalletRestoreService,
    receiveOperationService: ReceiveOperationService,
    tokenService: TokenService,
    balanceQueries: BalanceQueries,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.walletRestoreService = walletRestoreService;
    this.receiveOperationService = receiveOperationService;
    this.tokenService = tokenService;
    this.logger = logger;
    this.balances = new WalletBalancesApi(balanceQueries);
  }

  /**
   * Receive a token in one shot.
   *
   * For a multi-step receive flow (review fees/amounts before committing),
   * use `manager.ops.receive.prepare()` and `manager.ops.receive.execute()`.
   */
  async receive(token: Token | string): Promise<void> {
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
   * Exchange a source Wallet Seed's available proofs through ordinary Receive operations.
   * Keysets are independent; pending and uneconomic value are reported as skips.
   * @returns All per-keyset outcomes, even if every keyset fails or remains unresolved.
   * Callers must inspect the report; resolution does not imply a successful transfer.
   * Amounts are scoped to each keyset's unit. Inspect unresolved Receive IDs before retrying.
   * @throws If input validation or mint setup fails before keyset processing.
   * @param mintUrl - The URL of the mint to sweep
   * @param bip39seed - The BIP39 seed of the wallet to sweep
   */
  async sweep(
    mintUrl: string,
    bip39seed: Uint8Array,
    options?: WalletSweepOptions,
  ): Promise<SweepReport> {
    mintUrl = normalizeMintUrl(mintUrl);
    const unitFilter = this.getUnitFilter(options?.units);
    this.logger?.info('Starting sweep', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for sweep', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const report: SweepReport = { mintUrl, keysets: [] };
    for (const { keyset, unit } of this.getUnitScopedKeysets(mint.keysets, unitFilter)) {
      try {
        report.keysets.push(
          await this.walletRestoreService.sweepKeyset(mintUrl, keyset.id, bip39seed, unit),
        );
      } catch (cause) {
        report.keysets.push({
          keysetId: keyset.id,
          unit,
          status: 'failed',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      }
    }
    return report;
  }

  /**
   * Decode a token string into a Token object.
   * Uses the provided mint URL or extracts it from the token metadata, then loads
   * that mint's keysets through TokenService for decoding and unit resolution.
   *
   * @param tokenString - The encoded token string to decode
   * @param mintUrl - Optional mint URL to use instead of the token metadata's mint
   * @returns The decoded Token
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
