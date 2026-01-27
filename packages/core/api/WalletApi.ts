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
} from '@core/services';
import type { SendOperationService } from '../operations/send/SendOperationService';
import type { Logger } from '../logging/Logger.ts';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private transactionService: TransactionService;
  private paymentRequestService: PaymentRequestService;
  private sendOperationService: SendOperationService;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    walletRestoreService: WalletRestoreService,
    transactionService: TransactionService,
    paymentRequestService: PaymentRequestService,
    sendOperationService: SendOperationService,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.walletRestoreService = walletRestoreService;
    this.transactionService = transactionService;
    this.paymentRequestService = paymentRequestService;
    this.sendOperationService = sendOperationService;
    this.logger = logger;
  }

  async receive(token: Token | string): Promise<void> {
    return this.transactionService.receive(token);
  }

  /**
   * Send tokens from a mint.
   *
   * @deprecated Use `SendApi.prepareSend()` and SendApi.executePreparedSend() instead.
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

  // Payment Request methods

  /**
   * Parse and validate a payment request string.
   */
  async processPaymentRequest(paymentRequest: string): Promise<ParsedPaymentRequest> {
    return this.paymentRequestService.processPaymentRequest(paymentRequest);
  }

  /**
   * Prepare a payment request transaction.
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
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request (from readPaymentRequest)
   * @param inbandHandler - Callback to deliver the token (e.g., display QR, send via NFC)
   * @param amount - Optional amount (required if not specified in request)
   */
  async handleInbandPaymentRequest(
    transaction: PaymentRequestTransaction,
    inbandHandler: (token: Token) => Promise<void>,
  ): Promise<void> {
    return this.paymentRequestService.handleInbandPaymentRequest(transaction, inbandHandler);
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request (from readPaymentRequest)
   * @param amount - Optional amount (required if not specified in request)
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

  async decodeToken(tokenString: string): Promise<Token> {
    const metadata = getTokenMetadata(tokenString);
    const wallet = await this.walletService.getWallet(metadata.mint);
    return wallet.decodeToken(tokenString);
  }

  encodeToken(token: Token): string {
    return getEncodedToken(token);
  }
}
