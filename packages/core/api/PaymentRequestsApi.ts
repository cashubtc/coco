import type {
  PaymentRequestExecutionResult,
  PaymentRequestReceiveClaimResult,
  PaymentRequestReceiveService,
  PaymentRequestService,
  PreparedPaymentRequest,
  ResolvedPaymentRequest,
  CreatePaymentRequestReceiveInput,
} from '@core/services';
import type {
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveSource,
  PaymentRequestReceiveState,
} from '@core/operations/paymentRequestReceive';
import type { PaymentRequestPayload } from '@cashu/cashu-ts';
import { parseUnitAmount, type UnitAmountLike } from '../amounts.ts';

export interface IncomingPaymentRequestsApi {
  create(input: CreatePaymentRequestReceiveInput): Promise<PaymentRequestReceiveOperation>;
  activate(
    operationOrId: PaymentRequestReceiveOperation | string,
  ): Promise<PaymentRequestReceiveOperation>;
  cancel(operationId: string, reason?: string): Promise<PaymentRequestReceiveOperation>;
  get(operationId: string): Promise<PaymentRequestReceiveOperation | null>;
  list(filter?: { state?: PaymentRequestReceiveState }): Promise<PaymentRequestReceiveOperation[]>;
  claimPayload(
    operationOrId: PaymentRequestReceiveOperation | string,
    payload: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult>;
  ingestPayload(
    payload: PaymentRequestPayload | string,
    source?: PaymentRequestReceiveSource,
  ): Promise<PaymentRequestReceiveClaimResult>;
  readonly recovery: {
    run(): Promise<void>;
  };
  readonly diagnostics: {
    isLocked(operationId: string): boolean;
  };
}

/**
 * API for parsing, preparing, and executing payment requests.
 */
export class PaymentRequestsApi {
  private readonly paymentRequestService: PaymentRequestService;
  readonly incoming: IncomingPaymentRequestsApi;

  constructor(
    paymentRequestService: PaymentRequestService,
    paymentRequestReceiveService: PaymentRequestReceiveService,
  ) {
    this.paymentRequestService = paymentRequestService;
    this.incoming = {
      create: (input) => paymentRequestReceiveService.create(input),
      activate: (operationOrId) => paymentRequestReceiveService.activate(operationOrId),
      cancel: (operationId, reason) => paymentRequestReceiveService.cancel(operationId, reason),
      get: (operationId) => paymentRequestReceiveService.get(operationId),
      list: (filter) => paymentRequestReceiveService.list(filter),
      claimPayload: (operationOrId, payload, source) =>
        paymentRequestReceiveService.claimPayload(operationOrId, payload, source),
      ingestPayload: (payload, source) => paymentRequestReceiveService.ingestPayload(payload, source),
      recovery: {
        run: () => paymentRequestReceiveService.recoverPendingAttempts(),
      },
      diagnostics: {
        isLocked: (operationId) => paymentRequestReceiveService.isOperationLocked(operationId),
      },
    };
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
    options: { mintUrl: string; amount?: UnitAmountLike },
  ): Promise<PreparedPaymentRequest> {
    return this.paymentRequestService.prepare(request, {
      mintUrl: options.mintUrl,
      amount:
        options.amount === undefined
          ? undefined
          : parseUnitAmount(options.amount, {
              defaultUnit: request.unit,
              explicitUnit: request.unit,
            }),
    });
  }

  /**
   * Execute a prepared payment request.
   */
  async execute(transaction: PreparedPaymentRequest): Promise<PaymentRequestExecutionResult> {
    return this.paymentRequestService.execute(transaction);
  }
}
