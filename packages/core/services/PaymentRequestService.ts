import type { Logger } from '@core/logging';
import { PaymentRequest, PaymentRequestTransportType, type Token } from '@cashu/cashu-ts';
import { PaymentRequestError } from '../models/Error';
import type { ProofService } from '../services';
import type { PreparedSendOperation, SendOperationService } from '../operations/send';

type InbandTransport = { type: 'inband' };
type HttpTransport = { type: 'http'; url: string };
type Transport = InbandTransport | HttpTransport;

type ParsedPaymentRequest = {
  paymentRequest: PaymentRequest;
  matchingMints: string[];
  requiredMints: string[];
  amount?: number;
  transport: Transport;
};

export type PaymentRequestTransaction = {
  sendOperation: PreparedSendOperation;
  request: ParsedPaymentRequest;
};

export type { ParsedPaymentRequest, InbandTransport, HttpTransport, Transport };

export class PaymentRequestService {
  private readonly sendOperationService: SendOperationService;
  private readonly proofService: ProofService;
  private readonly logger?: Logger;

  constructor(
    sendOperationService: SendOperationService,
    proofService: ProofService,
    logger?: Logger,
  ) {
    this.sendOperationService = sendOperationService;
    this.proofService = proofService;
    this.logger = logger;
  }

  /**
   * Process a payment request and return a parsed payment request.
   * @param paymentRequest - The payment request to process
   * @returns The parsed payment request
   */
  async processPaymentRequest(paymentRequest: string): Promise<ParsedPaymentRequest> {
    const decodedPaymentRequest = await this.readPaymentRequest(paymentRequest);
    const transport = this.getPaymentRequestTransport(decodedPaymentRequest);
    const matchingMints = await this.findMatchingMints(decodedPaymentRequest);
    if (matchingMints.length === 0) {
      throw new PaymentRequestError('No matching mints found');
    }
    const requiredMints = decodedPaymentRequest.mints ?? [];
    return {
      paymentRequest: decodedPaymentRequest,
      matchingMints,
      requiredMints,
      amount: decodedPaymentRequest.amount,
      transport,
    };
  }

  /**
   * Handle an inband payment request by sending tokens and calling the handler.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request
   * @param inbandHandler - Callback to deliver the token
   * @param amount - Optional amount (required if not specified in request)
   */
  async preparePaymentRequestTransaction(
    mintUrl: string,
    request: ParsedPaymentRequest,
    amount?: number,
  ): Promise<PaymentRequestTransaction> {
    this.validateMint(mintUrl, request.requiredMints);
    const finalAmount = this.validateAmount(request, amount);
    this.logger?.debug('Preparing payment request transaction', { mintUrl, amount: finalAmount });
    const initSend = await this.sendOperationService.init(mintUrl, finalAmount);
    const preparedSend = await this.sendOperationService.prepare(initSend);
    this.logger?.debug('Payment request transaction prepared', { mintUrl, amount: finalAmount });
    return { sendOperation: preparedSend, request };
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request
   * @param amount - Optional amount (required if not specified in request)
   * @returns The HTTP response from the payment endpoint
   */
  async handleInbandPaymentRequest(
    transaction: PaymentRequestTransaction,
    inbandHandler: (token: Token) => Promise<void>,
  ): Promise<void> {
    if (transaction.request.transport.type !== 'inband') {
      throw new PaymentRequestError('Invalid transport type');
    }
    this.logger?.debug('Creating inband payment request token', {
      mintUrl: transaction.sendOperation.mintUrl,
      amount: transaction.request.amount,
    });
    const token = await this.sendOperationService.execute(transaction.sendOperation);
    this.logger?.debug('Executing inband payment request handler', {
      mintUrl: transaction.sendOperation.mintUrl,
      amount: transaction.request.amount,
    });
    await inbandHandler(token.token);
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request
   * @param amount - Optional amount (required if not specified in request)
   * @returns The HTTP response from the payment endpoint
   */
  async handleHttpPaymentRequest(transaction: PaymentRequestTransaction): Promise<Response> {
    if (transaction.request.transport.type !== 'http') {
      throw new PaymentRequestError('Invalid transport type');
    }
    this.logger?.debug('Handling HTTP payment request', {
      mintUrl: transaction.sendOperation.mintUrl,
      amount: transaction.request.amount,
      url: transaction.request.transport.url,
    });
    const token = await this.sendOperationService.execute(transaction.sendOperation);
    const response = await fetch(transaction.request.transport.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token),
    });
    this.logger?.debug('HTTP payment request completed', {
      mintUrl: transaction.sendOperation.mintUrl,
      amount: transaction.request.amount,
      url: transaction.request.transport.url,
      status: response.status,
    });
    return response;
  }

  private async readPaymentRequest(paymentRequest: string): Promise<PaymentRequest> {
    this.logger?.debug('Reading payment request', { paymentRequest });
    const decodedPaymentRequest = PaymentRequest.fromEncodedRequest(paymentRequest);
    this.logger?.info('Payment request decoded', {
      decodedPaymentRequest,
    });
    return decodedPaymentRequest;
  }

  private validateMint(mintUrl: string, mints?: string[]): void {
    if (mints && mints.length > 0 && !mints.includes(mintUrl)) {
      throw new PaymentRequestError(
        `Mint ${mintUrl} is not in the allowed mints list: ${mints.join(', ')}`,
      );
    }
  }

  private getPaymentRequestTransport(pr: PaymentRequest): Transport {
    if (!pr.transport || !Array.isArray(pr.transport)) {
      throw new PaymentRequestError('Malformed payment request: No transport');
    }
    if (pr.transport.length === 0) {
      return { type: 'inband' };
    }
    const httpTransport = pr.transport.find((t) => t.type === PaymentRequestTransportType.POST);
    if (httpTransport) {
      return { type: 'http', url: httpTransport.target };
    }
    const supportedTypes = pr.transport.map((t) => t.type).join(', ');
    throw new PaymentRequestError(
      `Unsupported transport type. Only HTTP POST is supported, found: ${supportedTypes}`,
    );
  }

  private async findMatchingMints(paymentRequest: PaymentRequest): Promise<string[]> {
    const balances = await this.proofService.getTrustedBalances();
    const amount = paymentRequest.amount ?? 0;
    const mintRequirement = paymentRequest.mints;
    const matchingMints: string[] = [];
    for (const [mintUrl, balance] of Object.entries(balances)) {
      if (balance >= amount && (!mintRequirement || mintRequirement.includes(mintUrl))) {
        matchingMints.push(mintUrl);
      }
    }
    return matchingMints;
  }

  private validateAmount(request: ParsedPaymentRequest, amount?: number): number {
    if (request.amount && amount && request.amount !== amount) {
      throw new PaymentRequestError(
        `Amount mismatch: request specifies ${request.amount} but ${amount} was provided`,
      );
    }
    const finalAmount = request.amount ?? amount;
    if (!finalAmount) {
      throw new PaymentRequestError('Amount is required but was not provided');
    }
    return finalAmount;
  }
}
