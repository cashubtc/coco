import type {
  PaymentRequestExecutionResult,
  PaymentRequestService,
  PreparedPaymentRequest,
  ResolvedPaymentRequest,
} from '@core/services';

/**
 * API for parsing, preparing, and executing payment requests.
 */
export class PaymentRequestsApi {
  private readonly paymentRequestService: PaymentRequestService;

  constructor(paymentRequestService: PaymentRequestService) {
    this.paymentRequestService = paymentRequestService;
  }

  /**
   * Parse and validate an encoded payment request.
   */
  async parse(paymentRequest: string): Promise<ResolvedPaymentRequest> {
    return this.paymentRequestService.parse(paymentRequest);
  }

  /**
   * Prepare a payment request for execution.
   */
  async prepare(
    request: ResolvedPaymentRequest,
    options: { mintUrl: string; amount?: number },
  ): Promise<PreparedPaymentRequest> {
    return this.paymentRequestService.prepare(request, options);
  }

  /**
   * Execute a prepared payment request.
   */
  async execute(transaction: PreparedPaymentRequest): Promise<PaymentRequestExecutionResult> {
    return this.paymentRequestService.execute(transaction);
  }
}
