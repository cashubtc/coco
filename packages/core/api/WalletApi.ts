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
  TransactionService,
  PaymentRequestService,
  ParsedPaymentRequest,
  PaymentRequestTransaction,
  TokenService,
} from '@core/services';
import type { SendOperationService } from '../operations/send/SendOperationService';
import type { ReceiveOperationService } from '../operations/receive/ReceiveOperationService';
import type { Logger } from '../logging/Logger.ts';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private transactionService: TransactionService;
  private paymentRequestService: PaymentRequestService;
  private sendOperationService: SendOperationService;
  private receiveOperationService: ReceiveOperationService;
  private readonly tokenService: TokenService;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    walletRestoreService: WalletRestoreService,
    transactionService: TransactionService,
    paymentRequestService: PaymentRequestService,
    sendOperationService: SendOperationService,
    receiveOperationService: ReceiveOperationService,
    tokenService: TokenService,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.walletRestoreService = walletRestoreService;
    this.transactionService = transactionService;
    this.paymentRequestService = paymentRequestService;
    this.sendOperationService = sendOperationService;
    this.receiveOperationService = receiveOperationService;
    this.tokenService = tokenService;
    this.logger = logger;
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

  /**
   * Send tokens from a mint.
   *
   * @deprecated Use `manager.ops.send.prepare()` and `manager.ops.send.execute()` instead.
   * This alias will be removed in a future release.
   *
   * @param mintUrl - The mint URL to send from
   * @param amount - The amount to send
   * @returns The token to share with the recipient
   */
  async send(mintUrl: string, amount: number): Promise<Token> {
    return this.sendOperationService.send(mintUrl, amount);
  }

  async getBalances(): Promise<{ [mintUrl: string]: number }> {
    return this.proofService.getBalances();
  }

  /**
   * Parse and validate a payment request string.
   *
   * @deprecated Use `manager.paymentRequests.parse()` instead.
   */
  async processPaymentRequest(paymentRequest: string): Promise<ParsedPaymentRequest> {
    return this.paymentRequestService.processPaymentRequest(paymentRequest);
  }

  /**
   * Prepare a payment request transaction.
   *
   * @deprecated Use `manager.paymentRequests.prepare()` instead.
   *
   * @param mintUrl - The mint to send from
   * @param request - The parsed payment request
   * @param amount - Optional amount (required if not specified in request)
   * @returns The payment request transaction
   */
  async preparePaymentRequestTransaction(
    mintUrl: string,
    request: ParsedPaymentRequest,
    amount?: number,
  ): Promise<PaymentRequestTransaction> {
    return this.paymentRequestService.preparePaymentRequestTransaction(mintUrl, request, amount);
  }

  /**
   * Handle an inband payment request by sending tokens and calling the handler.
   *
   * @deprecated Use `manager.paymentRequests.execute()` instead.
   *
   * @param transaction - The prepared payment request transaction
   * @param inbandHandler - Callback to deliver the token (e.g., display QR, send via NFC)
   */
  async handleInbandPaymentRequest(
    transaction: PaymentRequestTransaction,
    inbandHandler: (token: Token) => Promise<void>,
  ): Promise<void> {
    return this.paymentRequestService.handleInbandPaymentRequest(transaction, inbandHandler);
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   *
   * @deprecated Use `manager.paymentRequests.execute()` instead.
   *
   * @param transaction - The prepared payment request transaction
   * @returns The HTTP response from the payment endpoint
   */
  async handleHttpPaymentRequest(transaction: PaymentRequestTransaction): Promise<Response> {
    return this.paymentRequestService.handleHttpPaymentRequest(transaction);
  }

  // Restoration logic is delegated to WalletRestoreService

  async restore(mintUrl: string) {
    this.logger?.info('Starting restore', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for restore', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const keyset of mint.keysets) {
      try {
        await this.walletRestoreService.restoreKeyset(mintUrl, wallet, keyset.id);
      } catch (error) {
        this.logger?.error('Keyset restore failed', { mintUrl, keysetId: keyset.id, error });
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
  async sweep(mintUrl: string, bip39seed: Uint8Array) {
    this.logger?.info('Starting sweep', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for sweep', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const keyset of mint.keysets) {
      try {
        await this.walletRestoreService.sweepKeyset(mintUrl, keyset.id, bip39seed);
      } catch (error) {
        this.logger?.error('Keyset restore failed', { mintUrl, keysetId: keyset.id, error });
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
    const wallet = await this.walletService.getWallet(metadata.mint);
    return wallet.decodeToken(tokenString);
  }

  /**
   * Encode a token to a string.
   * @param token - The token to encode
   * @param opts - Optional encoding options
   * @param opts.version - Token version (3 for cashuA, 4 for cashuB). Defaults to 4 if keyset allows it.
   * @returns Encoded token string
   */
  encodeToken(token: Token, opts?: { version?: 3 | 4 }): string {
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
}
