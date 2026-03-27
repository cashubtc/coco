import type { Logger } from '@core/logging';
import { PaymentRequest, PaymentRequestTransportType, type Token } from '@cashu/cashu-ts';
import { PaymentRequestError } from '../models/Error';
import type { ProofService } from '../services';
import type {
  PendingSendOperation,
  PreparedSendOperation,
  SendOperationService,
} from '../operations/send';

type InbandPaymentRequestTransport = { type: 'inband' };
type HttpPaymentRequestTransport = { type: 'http'; url: string };
type PaymentRequestTransport = InbandPaymentRequestTransport | HttpPaymentRequestTransport;

type ResolvedPaymentRequest = {
  paymentRequest: PaymentRequest;
  payableMints: string[];
  allowedMints: string[];
  amount?: number;
  transport: PaymentRequestTransport;
};

export type PreparedPaymentRequest = {
  sendOperation: PreparedSendOperation;
  request: ResolvedPaymentRequest;
};

export type InbandPaymentRequestExecutionResult = {
  type: 'inband';
  token: Token;
  operation: PendingSendOperation;
  request: ResolvedPaymentRequest;
};

export type HttpPaymentRequestExecutionResult = {
  type: 'http';
  response: Response;
  operation: PendingSendOperation;
  request: ResolvedPaymentRequest;
};

export type PaymentRequestExecutionResult =
  | InbandPaymentRequestExecutionResult
  | HttpPaymentRequestExecutionResult;

type ParsedPaymentRequest = {
  paymentRequest: PaymentRequest;
  matchingMints: string[];
  requiredMints: string[];
  amount?: number;
  transport: PaymentRequestTransport;
};

export type PaymentRequestTransaction = {
  sendOperation: PreparedSendOperation;
  request: ParsedPaymentRequest;
};

type InbandTransport = InbandPaymentRequestTransport;
type HttpTransport = HttpPaymentRequestTransport;
type Transport = PaymentRequestTransport;

export type {
  ResolvedPaymentRequest,
  ParsedPaymentRequest,
  InbandPaymentRequestTransport,
  HttpPaymentRequestTransport,
  PaymentRequestTransport,
  InbandTransport,
  HttpTransport,
  Transport,
};

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
   * Parse and validate a payment request.
   * @param paymentRequest - The payment request to process
   * @returns The resolved payment request
   */
  async parse(paymentRequest: string): Promise<ResolvedPaymentRequest> {
    const decodedPaymentRequest = await this.readPaymentRequest(paymentRequest);
    const transport = this.getPaymentRequestTransport(decodedPaymentRequest);
    const payableMints = await this.findMatchingMints(decodedPaymentRequest);
    const allowedMints = decodedPaymentRequest.mints ?? [];
    return {
      paymentRequest: decodedPaymentRequest,
      payableMints,
      allowedMints,
      amount: decodedPaymentRequest.amount,
      transport,
    };
  }

  /**
   * Prepare a payment request for execution.
   */
  async prepare(
    request: ResolvedPaymentRequest,
    options: { mintUrl: string; amount?: number },
  ): Promise<PreparedPaymentRequest> {
    const { mintUrl, amount } = options;
    this.validateMint(mintUrl, request.allowedMints);
    const finalAmount = this.validateAmount(request, amount);
    const preparedRequest = await this.resolvePreparedRequest(request, finalAmount);
    this.logger?.debug('Preparing payment request transaction', { mintUrl, amount: finalAmount });
    const initSend = await this.sendOperationService.init(mintUrl, finalAmount);
    const preparedSend = await this.sendOperationService.prepare(initSend);
    this.logger?.debug('Payment request transaction prepared', { mintUrl, amount: finalAmount });
    return { sendOperation: preparedSend, request: preparedRequest };
  }

  /**
   * Execute a prepared payment request.
   */
  async execute(transaction: PreparedPaymentRequest): Promise<PaymentRequestExecutionResult> {
    switch (transaction.request.transport.type) {
      case 'inband': {
        this.logger?.debug('Creating inband payment request token', {
          mintUrl: transaction.sendOperation.mintUrl,
          amount: transaction.request.amount,
        });
        const { operation, token } = await this.sendOperationService.execute(
          transaction.sendOperation,
        );
        return {
          type: 'inband',
          token,
          operation,
          request: transaction.request,
        };
      }
      case 'http': {
        this.logger?.debug('Handling HTTP payment request', {
          mintUrl: transaction.sendOperation.mintUrl,
          amount: transaction.request.amount,
          url: transaction.request.transport.url,
        });
        const { operation, token } = await this.sendOperationService.execute(
          transaction.sendOperation,
        );
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
        return {
          type: 'http',
          response,
          operation,
          request: transaction.request,
        };
      }
    }
  }

  /**
   * Parse and validate a payment request.
   * @deprecated Use `parse()` instead.
   */
  async processPaymentRequest(paymentRequest: string): Promise<ParsedPaymentRequest> {
    return this.toParsedPaymentRequest(await this.parse(paymentRequest));
  }

  /**
   * Prepare a payment request transaction.
   * @deprecated Use `prepare()` instead.
   */
  async preparePaymentRequestTransaction(
    mintUrl: string,
    request: ParsedPaymentRequest | ResolvedPaymentRequest,
    amount?: number,
  ): Promise<PaymentRequestTransaction> {
    const prepared = await this.prepare(this.toResolvedPaymentRequest(request), {
      mintUrl,
      amount,
    });
    return this.toPaymentRequestTransaction(prepared);
  }

  /**
   * Execute an inband payment request.
   * @deprecated Use `execute()` instead.
   */
  async handleInbandPaymentRequest(
    transaction: PaymentRequestTransaction | PreparedPaymentRequest,
    inbandHandler: (token: Token) => Promise<void>,
  ): Promise<void> {
    const prepared = this.toPreparedPaymentRequest(transaction);
    if (prepared.request.transport.type !== 'inband') {
      throw new PaymentRequestError('Invalid transport type');
    }
    const result = await this.execute(prepared);
    if (result.type !== 'inband') {
      throw new PaymentRequestError('Invalid transport type');
    }
    this.logger?.debug('Executing inband payment request handler', {
      mintUrl: result.operation.mintUrl,
      amount: result.request.amount,
    });
    await inbandHandler(result.token);
  }

  /**
   * Execute an HTTP payment request.
   * @deprecated Use `execute()` instead.
   */
  async handleHttpPaymentRequest(
    transaction: PaymentRequestTransaction | PreparedPaymentRequest,
  ): Promise<Response> {
    const prepared = this.toPreparedPaymentRequest(transaction);
    if (prepared.request.transport.type !== 'http') {
      throw new PaymentRequestError('Invalid transport type');
    }
    const result = await this.execute(prepared);
    if (result.type !== 'http') {
      throw new PaymentRequestError('Invalid transport type');
    }
    return result.response;
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

  private getPaymentRequestTransport(pr: PaymentRequest): PaymentRequestTransport {
    if (!pr.transport || (Array.isArray(pr.transport) && pr.transport.length === 0)) {
      return { type: 'inband' };
    }
    if (!Array.isArray(pr.transport)) {
      throw new PaymentRequestError('Malformed payment request: Invalid transport');
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

  private validateAmount(request: ResolvedPaymentRequest, amount?: number): number {
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

  private async resolvePreparedRequest(
    request: ResolvedPaymentRequest,
    amount: number,
  ): Promise<ResolvedPaymentRequest> {
    if (request.amount === amount) {
      return request;
    }

    const paymentRequest = new PaymentRequest(
      request.paymentRequest.transport,
      request.paymentRequest.id,
      amount,
      request.paymentRequest.unit,
      request.paymentRequest.mints,
      request.paymentRequest.description,
      request.paymentRequest.singleUse,
      request.paymentRequest.nut10,
    );
    const payableMints = await this.findMatchingMints(paymentRequest);

    return {
      ...request,
      amount,
      payableMints,
      paymentRequest,
    };
  }

  private toResolvedPaymentRequest(
    request: ParsedPaymentRequest | ResolvedPaymentRequest,
  ): ResolvedPaymentRequest {
    if ('payableMints' in request && 'allowedMints' in request) {
      return request;
    }

    return {
      paymentRequest: request.paymentRequest,
      payableMints: request.matchingMints,
      allowedMints: request.requiredMints,
      amount: request.amount,
      transport: request.transport,
    };
  }

  private toParsedPaymentRequest(request: ResolvedPaymentRequest): ParsedPaymentRequest {
    return {
      paymentRequest: request.paymentRequest,
      matchingMints: request.payableMints,
      requiredMints: request.allowedMints,
      amount: request.amount,
      transport: request.transport,
    };
  }

  private toPreparedPaymentRequest(
    transaction: PaymentRequestTransaction | PreparedPaymentRequest,
  ): PreparedPaymentRequest {
    return {
      sendOperation: transaction.sendOperation,
      request: this.toResolvedPaymentRequest(transaction.request),
    };
  }

  private toPaymentRequestTransaction(
    transaction: PreparedPaymentRequest,
  ): PaymentRequestTransaction {
    return {
      sendOperation: transaction.sendOperation,
      request: this.toParsedPaymentRequest(transaction.request),
    };
  }
}
