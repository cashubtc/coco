import type { Logger } from '@core/logging';
import {
  Amount,
  JSONInt,
  PaymentRequest,
  PaymentRequestTransportType,
  type NUT10Option,
  type P2PKOptions,
  type Token,
} from '@cashu/cashu-ts';
import { PaymentRequestError } from '../models/Error';
import type { ProofService } from '../services';
import type { MintService } from '../services/MintService.ts';
import type {
  CreateSendOperationOptions,
  PendingSendOperation,
  PreparedSendOperation,
  SendOperationService,
} from '../operations/send';
import { DEFAULT_UNIT, normalizeUnit, type UnitAmount } from '../amounts.ts';

type InbandPaymentRequestTransport = { type: 'inband' };
type HttpPaymentRequestTransport = { type: 'http'; url: string };
type NostrPaymentRequestTransport = {
  type: 'nostr';
  target: string;
  tags?: string[][];
};
type PaymentRequestTransport =
  | InbandPaymentRequestTransport
  | HttpPaymentRequestTransport
  | NostrPaymentRequestTransport;

export type PaymentRequestP2pkRequirement = {
  kind: 'P2PK';
  options: P2PKOptions;
  rawNut10: NUT10Option;
};

export type PaymentRequestUnsupportedSpendingCondition = {
  kind: 'unsupported';
  nut10Kind: string;
  reason: string;
  rawNut10: NUT10Option;
};

export type PaymentRequestMalformedSpendingCondition = {
  kind: 'malformed';
  nut10Kind: string;
  reason: string;
  rawNut10: NUT10Option;
};

export type PaymentRequestSpendingConditionRequirement =
  | {
      kind: 'P2PK';
      p2pk: PaymentRequestP2pkRequirement;
    }
  | PaymentRequestUnsupportedSpendingCondition
  | PaymentRequestMalformedSpendingCondition;

type ResolvedPaymentRequest = {
  paymentRequest: PaymentRequest;
  payableMints: string[];
  allowedMints: string[];
  amount?: Amount;
  unit: string;
  transport: PaymentRequestTransport;
  spendingCondition?: PaymentRequestSpendingConditionRequirement;
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

type InbandTransport = InbandPaymentRequestTransport;
type HttpTransport = HttpPaymentRequestTransport;
type NostrTransport = NostrPaymentRequestTransport;
type Transport = PaymentRequestTransport;

export type {
  ResolvedPaymentRequest,
  InbandPaymentRequestTransport,
  HttpPaymentRequestTransport,
  NostrPaymentRequestTransport,
  PaymentRequestTransport,
  InbandTransport,
  HttpTransport,
  NostrTransport,
  Transport,
};

export class PaymentRequestService {
  private readonly sendOperationService: SendOperationService;
  private readonly proofService: ProofService;
  private readonly mintService: MintService;
  private readonly logger?: Logger;

  constructor(
    sendOperationService: SendOperationService,
    proofService: ProofService,
    mintService: MintService,
    logger?: Logger,
  ) {
    this.sendOperationService = sendOperationService;
    this.proofService = proofService;
    this.mintService = mintService;
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
    const unit = normalizeUnit(decodedPaymentRequest.unit, { defaultUnit: DEFAULT_UNIT });
    const spendingCondition = this.resolveSpendingCondition(decodedPaymentRequest);
    const payableMints = await this.findMatchingMints(
      decodedPaymentRequest,
      unit,
      spendingCondition,
    );
    const allowedMints = decodedPaymentRequest.mints ?? [];
    return {
      paymentRequest: decodedPaymentRequest,
      payableMints,
      allowedMints,
      amount: decodedPaymentRequest.amount,
      unit,
      transport,
      spendingCondition,
    };
  }

  /**
   * Prepare a payment request for execution.
   */
  async prepare(
    request: ResolvedPaymentRequest,
    options: { mintUrl: string; amount?: UnitAmount },
  ): Promise<PreparedPaymentRequest> {
    const { mintUrl, amount } = options;
    this.validateMint(mintUrl, request.allowedMints);
    const finalAmount = this.validateAmount(request, amount);
    const preparedRequest = await this.resolvePreparedRequest(request, finalAmount);
    const sendOptions = await this.resolveSendOptions(preparedRequest, mintUrl);
    this.logger?.debug('Preparing payment request transaction', { mintUrl, amount: finalAmount });
    const initSend = await this.sendOperationService.init(mintUrl, finalAmount, sendOptions);
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
          body: JSONInt.stringify(token),
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
      case 'nostr': {
        const error = new PaymentRequestError(
          'Nostr payment request execution requires a transport plugin',
        );
        try {
          await this.sendOperationService.rollback(
            transaction.sendOperation.id,
            'Nostr payment request execution requires a transport plugin',
          );
        } catch (cause) {
          this.logger?.error('Failed to roll back Nostr payment request send operation', {
            operationId: transaction.sendOperation.id,
            cause,
          });
          throw new PaymentRequestError(
            'Nostr payment request execution requires a transport plugin; rollback failed',
            cause,
          );
        }
        throw error;
      }
    }
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
    const nostrTransport = pr.transport.find((t) => t.type === PaymentRequestTransportType.NOSTR);
    if (nostrTransport) {
      return {
        type: 'nostr',
        target: nostrTransport.target,
        tags: nostrTransport.tags,
      };
    }
    const supportedTypes = pr.transport.map((t) => t.type).join(', ');
    throw new PaymentRequestError(
      'Unsupported transport type. Only HTTP POST and Nostr are supported, found: ' +
        supportedTypes,
    );
  }

  private async findMatchingMints(
    paymentRequest: PaymentRequest,
    unit: string,
    spendingCondition?: PaymentRequestSpendingConditionRequirement,
  ): Promise<string[]> {
    if (
      spendingCondition &&
      (spendingCondition.kind === 'unsupported' || spendingCondition.kind === 'malformed')
    ) {
      return [];
    }

    const normalizedUnit = normalizeUnit(unit, { defaultUnit: DEFAULT_UNIT });
    const balances = await this.proofService.getBalancesByMint({
      trustedOnly: true,
      units: [normalizedUnit],
    });
    const amount = paymentRequest.amount ?? Amount.zero();
    const mintRequirement = paymentRequest.mints;
    const matchingMints: string[] = [];
    for (const [mintUrl, balance] of Object.entries(balances)) {
      if (
        balance.spendable.greaterThanOrEqual(amount) &&
        (!mintRequirement || mintRequirement.includes(mintUrl))
      ) {
        if (
          spendingCondition?.kind === 'P2PK' &&
          !(await this.mintService.supportsNut(mintUrl, 11))
        ) {
          continue;
        }
        matchingMints.push(mintUrl);
      }
    }
    return matchingMints;
  }

  private resolveSpendingCondition(
    paymentRequest: PaymentRequest,
  ): PaymentRequestSpendingConditionRequirement | undefined {
    const rawNut10 = paymentRequest.nut10;
    if (!rawNut10) {
      return undefined;
    }

    const nut10Kind = this.getNut10Kind(rawNut10);
    if (nut10Kind !== 'P2PK') {
      return {
        kind: 'unsupported',
        nut10Kind,
        reason: `Unsupported NUT-10 spending condition '${nut10Kind}'`,
        rawNut10,
      };
    }

    try {
      const options = paymentRequest.toP2PKOptions();
      if (!options) {
        return {
          kind: 'malformed',
          nut10Kind,
          reason: 'NUT-10 P2PK spending condition could not be normalized',
          rawNut10,
        };
      }

      return {
        kind: 'P2PK',
        p2pk: {
          kind: 'P2PK',
          options,
          rawNut10,
        },
      };
    } catch (error) {
      return {
        kind: 'malformed',
        nut10Kind,
        reason: error instanceof Error ? error.message : String(error),
        rawNut10,
      };
    }
  }

  private getNut10Kind(nut10: NUT10Option): string {
    const compact = nut10 as NUT10Option & { k?: unknown };
    if (typeof nut10.kind === 'string' && nut10.kind.length > 0) {
      return nut10.kind;
    }
    if (typeof compact.k === 'string' && compact.k.length > 0) {
      return compact.k;
    }
    return 'unknown';
  }

  private async resolveSendOptions(
    request: ResolvedPaymentRequest,
    mintUrl: string,
  ): Promise<CreateSendOperationOptions | undefined> {
    const spendingCondition = request.spendingCondition;
    if (!spendingCondition) {
      return undefined;
    }

    if (spendingCondition.kind === 'unsupported') {
      throw new PaymentRequestError(
        `Unsupported NUT-10 spending condition '${spendingCondition.nut10Kind}'`,
      );
    }

    if (spendingCondition.kind === 'malformed') {
      this.throwMalformedSpendingCondition(spendingCondition, request.paymentRequest);
    }

    const options = this.normalizeP2pkOptionsForPrepare(request.paymentRequest);

    try {
      await this.mintService.assertNutSupported(mintUrl, 11, 'payment request P2PK');
    } catch (cause) {
      throw new PaymentRequestError(
        `Mint ${mintUrl} does not support NUT-11 required by payment request P2PK`,
        cause,
      );
    }

    return {
      method: 'p2pk',
      methodData: { options },
    };
  }

  private normalizeP2pkOptionsForPrepare(paymentRequest: PaymentRequest): P2PKOptions {
    try {
      const options = paymentRequest.toP2PKOptions();
      if (!options) {
        throw new PaymentRequestError('NUT-10 P2PK spending condition could not be normalized');
      }
      return options;
    } catch (cause) {
      throw new PaymentRequestError('Malformed NUT-10 P2PK spending condition', cause);
    }
  }

  private throwMalformedSpendingCondition(
    spendingCondition: PaymentRequestMalformedSpendingCondition,
    paymentRequest: PaymentRequest,
  ): never {
    const message =
      `Malformed NUT-10 spending condition '${spendingCondition.nut10Kind}': ` +
      spendingCondition.reason;

    if (spendingCondition.nut10Kind === 'P2PK') {
      try {
        this.normalizeP2pkOptionsForPrepare(paymentRequest);
      } catch (cause) {
        throw new PaymentRequestError(message, cause);
      }
    }

    throw new PaymentRequestError(message);
  }

  private validateAmount(request: ResolvedPaymentRequest, amount?: UnitAmount): UnitAmount {
    const providedAmount = amount?.amount;
    if (amount) {
      if (normalizeUnit(amount.unit) !== request.unit) {
        throw new PaymentRequestError(
          `Unit mismatch: request specifies ${request.unit} but ${amount.unit} was provided`,
        );
      }
    }
    if (request.amount && providedAmount && !request.amount.equals(providedAmount)) {
      throw new PaymentRequestError(
        `Amount mismatch: request specifies ${request.amount} but ${providedAmount} was provided`,
      );
    }
    const finalAmount = request.amount ?? providedAmount;
    if (!finalAmount) {
      throw new PaymentRequestError('Amount is required but was not provided');
    }
    return { amount: finalAmount, unit: request.unit };
  }

  private async resolvePreparedRequest(
    request: ResolvedPaymentRequest,
    intent: UnitAmount,
  ): Promise<ResolvedPaymentRequest> {
    const amount = intent.amount;
    const amountUnchanged = request.amount?.equals(amount) === true;
    if (amountUnchanged && !request.paymentRequest.nut10 && !request.spendingCondition) {
      return request;
    }

    const paymentRequest = amountUnchanged
      ? request.paymentRequest
      : new PaymentRequest(
          request.paymentRequest.transport,
          request.paymentRequest.id,
          amount,
          request.unit,
          request.paymentRequest.mints,
          request.paymentRequest.description,
          request.paymentRequest.singleUse,
          request.paymentRequest.nut10,
        );
    const spendingCondition = this.resolveSpendingCondition(paymentRequest);
    const payableMints = await this.findMatchingMints(
      paymentRequest,
      request.unit,
      spendingCondition,
    );

    return {
      ...request,
      amount,
      unit: request.unit,
      payableMints,
      paymentRequest,
      spendingCondition,
    };
  }
}
