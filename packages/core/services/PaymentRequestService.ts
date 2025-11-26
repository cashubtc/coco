import type { Logger } from '@core/logging';
import { PaymentRequest, PaymentRequestTransportType, type Token } from '@cashu/cashu-ts';
import type { TransactionService } from './TransactionService';
import { PaymentRequestError } from '../models/Error';

type InbandTransport = { type: 'inband' };
type HttpTransport = { type: 'http'; url: string };
type Transport = InbandTransport | HttpTransport;

type PreparedPaymentRequestBase = {
  mints?: string[];
};

type PreparedInbandPaymentRequest = PreparedPaymentRequestBase & {
  transport: InbandTransport;
  amount?: number;
};

type PreparedHttpPaymentRequest = PreparedPaymentRequestBase & {
  transport: HttpTransport;
  amount?: number;
};

type PreparedPaymentRequest = PreparedInbandPaymentRequest | PreparedHttpPaymentRequest;

export type {
  PreparedPaymentRequest,
  PreparedInbandPaymentRequest,
  PreparedHttpPaymentRequest,
  InbandTransport,
  HttpTransport,
  Transport,
};

export class PaymentRequestService {
  private readonly transactionService: TransactionService;
  private readonly logger?: Logger;

  constructor(transactionService: TransactionService, logger?: Logger) {
    this.transactionService = transactionService;
    this.logger = logger;
  }

  async readPaymentRequest(paymentRequest: string): Promise<PreparedPaymentRequest> {
    this.logger?.debug('Reading payment request', { paymentRequest });
    const decodedPaymentRequest = PaymentRequest.fromEncodedRequest(paymentRequest);
    if (decodedPaymentRequest.nut10) {
      throw new PaymentRequestError('Locked tokens (NUT-10) are not supported');
    }
    const transport = this.getPaymentRequestTransport(decodedPaymentRequest);
    const base = {
      mints: decodedPaymentRequest.mints,
      amount: decodedPaymentRequest.amount,
    };
    this.logger?.info('Payment request decoded', {
      transport: transport.type,
      mints: base.mints,
      amount: base.amount,
    });
    if (transport.type === 'inband') {
      return { ...base, transport };
    }
    return { ...base, transport };
  }

  /**
   * Handle an inband payment request by sending tokens and calling the handler.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request
   * @param inbandHandler - Callback to deliver the token
   * @param amount - Optional amount (required if not specified in request)
   */
  async handleInbandPaymentRequest(
    mintUrl: string,
    request: PreparedInbandPaymentRequest,
    inbandHandler: (t: Token) => Promise<void>,
    amount?: number,
  ): Promise<void> {
    this.validateMint(mintUrl, request.mints);
    const finalAmount = this.validateAmount(request, amount);
    this.logger?.info('Handling inband payment request', { mintUrl, amount: finalAmount });
    const token = await this.transactionService.send(mintUrl, finalAmount);
    await inbandHandler(token);
    this.logger?.debug('Inband payment request completed', { mintUrl, amount: finalAmount });
  }

  /**
   * Handle an HTTP payment request by sending tokens to the specified URL.
   * @param mintUrl - The mint to send from
   * @param request - The prepared payment request
   * @param amount - Optional amount (required if not specified in request)
   * @returns The HTTP response from the payment endpoint
   */
  async handleHttpPaymentRequest(
    mintUrl: string,
    request: PreparedHttpPaymentRequest,
    amount?: number,
  ): Promise<Response> {
    this.validateMint(mintUrl, request.mints);
    const finalAmount = this.validateAmount(request, amount);
    this.logger?.info('Handling HTTP payment request', {
      mintUrl,
      amount: finalAmount,
      url: request.transport.url,
    });
    const token = await this.transactionService.send(mintUrl, finalAmount);
    const response = await fetch(request.transport.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token),
    });
    this.logger?.debug('HTTP payment request completed', {
      mintUrl,
      amount: finalAmount,
      url: request.transport.url,
      status: response.status,
    });
    return response;
  }

  private validateMint(mintUrl: string, mints?: string[]): void {
    if (mints && !mints.includes(mintUrl)) {
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

  private validateAmount(request: PreparedPaymentRequest, amount?: number): number {
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
