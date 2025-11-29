import type { Token } from '@cashu/cashu-ts';
import type {
  MintService,
  WalletService,
  ProofService,
  WalletRestoreService,
  TransactionService,
  PaymentRequestService,
  PreparedPaymentRequest,
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
  async readPaymentRequest(paymentRequest: string): Promise<PreparedPaymentRequest> {
    return this.paymentRequestService.readPaymentRequest(paymentRequest);
  }

  /**
   * Handle an inband payment request by sending tokens and calling the handler.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request (from readPaymentRequest)
   * @param inbandHandler - Callback to deliver the token (e.g., display QR, send via NFC)
   * @param amount - Optional amount (required if not specified in request)
   */
  async handleInbandPaymentRequest(
    mintUrl: string,
    request: PreparedPaymentRequest & { transport: { type: 'inband' } },
    inbandHandler: (t: Token) => Promise<void>,
    amount?: number,
  ): Promise<void> {
    return this.paymentRequestService.handleInbandPaymentRequest(
      mintUrl,
      request,
      inbandHandler,
      amount,
    );
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request (from readPaymentRequest)
   * @param amount - Optional amount (required if not specified in request)
   * @returns The HTTP response from the payment endpoint
   */
  async handleHttpPaymentRequest(
    mintUrl: string,
    request: PreparedPaymentRequest & { transport: { type: 'http'; url: string } },
    amount?: number,
  ): Promise<Response> {
    return this.paymentRequestService.handleHttpPaymentRequest(mintUrl, request, amount);
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
}
