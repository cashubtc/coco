import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import { createAmountfulInvoice, getBolt11AmountSats } from './bolt11.ts';
import type {
  IncomingPayment,
  OutgoingPayment,
  PaymentAmount,
  PaymentProcessorSnapshot,
} from './types.ts';

type PaymentIdentifier = {
  type: string;
  id?: string;
  hash?: string;
};

type StoredOutgoingPayment = OutgoingPayment & {
  callback?: grpc.sendUnaryData<Record<string, unknown>>;
};

type CreatePaymentRequest = {
  options?: { bolt11?: { amount?: PaymentAmount } };
};

type PaymentQuoteRequest = {
  request: string;
  quoteId: string;
  unit: string;
};

type MakePaymentRequest = {
  paymentOptions?: { bolt11?: { bolt11: string; quoteId: string } };
};

type CheckPaymentRequest = {
  requestIdentifier?: PaymentIdentifier;
};

type ProcessorPackage = {
  CdkPaymentProcessor: { service: grpc.ServiceDefinition };
};

function paymentIdentifier(id: string): PaymentIdentifier {
  return { type: 'PAYMENT_IDENTIFIER_TYPE_CUSTOM_ID', id };
}

function paymentIdentifierValue(value: PaymentIdentifier | undefined): string | undefined {
  return value?.id ?? value?.hash;
}

function cloneIncoming(payment: IncomingPayment): IncomingPayment {
  return { ...payment, amount: { ...payment.amount } };
}

function cloneOutgoing(payment: OutgoingPayment): OutgoingPayment {
  return { ...payment, amount: { ...payment.amount }, fee: { ...payment.fee } };
}

/**
 * In-memory implementation of CDK's payment-processor protocol.
 *
 * @experimental This interface may change without notice.
 */
export class ControllablePaymentProcessor {
  private readonly incoming = new Map<string, IncomingPayment>();
  private readonly outgoing = new Map<string, StoredOutgoingPayment>();
  private readonly streams = new Set<grpc.ServerWritableStream<Record<string, never>, unknown>>();
  private readonly outgoingWaiters = new Set<() => void>();
  private nextIncomingId = 1;
  private server?: grpc.Server;
  private observedProtocolVersion?: string;

  /** Create a valid, unpayable BOLT11 invoice for an outgoing melt test. */
  createOutgoingInvoice(options: { amount: number }): string {
    return createAmountfulInvoice(options.amount);
  }

  /** Settle the incoming payment associated with a mint quote request. */
  async settleIncoming(options: { request: string }): Promise<IncomingPayment> {
    const payment = [...this.incoming.values()].find(
      (candidate) => candidate.request === options.request,
    );
    if (!payment) throw new Error('Unknown incoming payment request');

    payment.state = 'PAID';
    const paymentReceived = {
      paymentReceived: {
        paymentIdentifier: paymentIdentifier(payment.id),
        paymentAmount: payment.amount,
        paymentId: `settlement-${payment.id}`,
      },
    };
    for (const stream of this.streams) stream.write(paymentReceived);
    return cloneIncoming(payment);
  }

  /** Wait until CDK asks the processor to pay an outgoing quote. */
  async waitForOutgoing(options?: {
    quoteId?: string;
    timeoutMs?: number;
  }): Promise<OutgoingPayment> {
    const pending = [...this.outgoing.values()].find(
      (payment) =>
        payment.state === 'PENDING' && (!options?.quoteId || payment.quoteId === options.quoteId),
    );
    if (pending) return cloneOutgoing(pending);

    const timeoutMs = options?.timeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        clearTimeout(timeout);
        this.outgoingWaiters.delete(waiter);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.outgoingWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for an outgoing payment after ${timeoutMs}ms`));
      }, timeoutMs);
      this.outgoingWaiters.add(waiter);
    });
    return this.waitForOutgoing(options);
  }

  /** Complete an outgoing payment successfully. */
  async succeedOutgoing(options: { quoteId: string }): Promise<OutgoingPayment> {
    const payment = this.outgoing.get(options.quoteId);
    if (!payment) throw new Error(`Unknown outgoing payment quote: ${options.quoteId}`);
    if (!payment.callback) throw new Error(`Outgoing payment ${options.quoteId} is not pending`);

    payment.state = 'PAID';
    payment.callback(null, this.makePaymentResponse(payment));
    payment.callback = undefined;
    return cloneOutgoing(payment);
  }

  /** Return a serializable copy of all processor state. */
  snapshot(): PaymentProcessorSnapshot {
    return {
      incoming: [...this.incoming.values()].map(cloneIncoming),
      outgoing: [...this.outgoing.values()].map(cloneOutgoing),
      protocolVersion: this.observedProtocolVersion,
    };
  }

  async start(protoPath: string, port: number): Promise<void> {
    if (this.server) throw new Error('Payment processor is already running');
    const definition = protoLoader.loadSync(protoPath, {
      defaults: true,
      enums: String,
      keepCase: false,
      longs: Number,
      oneofs: true,
    });
    const loaded = grpc.loadPackageDefinition(definition) as unknown as {
      cdk_payment_processor: ProcessorPackage;
    };

    const server = new grpc.Server();
    server.addService(
      loaded.cdk_payment_processor.CdkPaymentProcessor.service,
      this.implementation(),
    );
    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (error) =>
        error ? reject(error) : resolve(),
      );
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
  }

  private implementation(): grpc.UntypedServiceImplementation {
    return {
      getSettings: this.getSettings,
      createPayment: this.createPayment,
      getPaymentQuote: this.getPaymentQuote,
      makePayment: this.makePayment,
      checkIncomingPayment: this.checkIncomingPayment,
      checkOutgoingPayment: this.checkOutgoingPayment,
      waitPaymentEvent: this.waitPaymentEvent,
    };
  }

  private observeProtocol(call: { metadata: grpc.Metadata }): void {
    const header = call.metadata.get('x-cdk-protocol-version')[0];
    this.observedProtocolVersion = typeof header === 'string' ? header : undefined;
  }

  private readonly getSettings: grpc.handleUnaryCall<
    Record<string, never>,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    callback(null, {
      unit: 'sat',
      bolt11: { mpp: false, amountless: false, invoiceDescription: true },
    });
  };

  private readonly createPayment: grpc.handleUnaryCall<
    CreatePaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const amount = call.request.options?.bolt11?.amount;
    if (!amount)
      return callback(new Error('Only amountful BOLT11 incoming payments are supported'));

    const id = `incoming-${this.nextIncomingId++}`;
    const payment: IncomingPayment = {
      id,
      request: createAmountfulInvoice(amount.value),
      amount,
      state: 'UNPAID',
    };
    this.incoming.set(id, payment);
    callback(null, {
      requestIdentifier: paymentIdentifier(id),
      request: payment.request,
      expiry: Math.floor(Date.now() / 1000) + 3600,
    });
  };

  private readonly getPaymentQuote: grpc.handleUnaryCall<
    PaymentQuoteRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const payment: StoredOutgoingPayment = {
      quoteId: call.request.quoteId,
      request: call.request.request,
      amount: { value: getBolt11AmountSats(call.request.request), unit: call.request.unit },
      fee: { value: 1, unit: call.request.unit },
      state: 'UNPAID',
    };
    this.outgoing.set(payment.quoteId, payment);
    callback(null, {
      requestIdentifier: paymentIdentifier(payment.quoteId),
      amount: payment.amount,
      fee: payment.fee,
      state: 'QUOTE_STATE_UNPAID',
    });
  };

  private readonly makePayment: grpc.handleUnaryCall<MakePaymentRequest, Record<string, unknown>> =
    (call, callback) => {
      this.observeProtocol(call);
      const options = call.request.paymentOptions?.bolt11;
      if (!options) return callback(new Error('Only BOLT11 outgoing payments are supported'));

      const payment = this.outgoing.get(options.quoteId);
      if (!payment) return callback(new Error(`Unknown outgoing quote: ${options.quoteId}`));
      payment.state = 'PENDING';
      payment.callback = callback;
      for (const waiter of this.outgoingWaiters) waiter();
      this.outgoingWaiters.clear();
    };

  private readonly checkIncomingPayment: grpc.handleUnaryCall<
    CheckPaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const id = paymentIdentifierValue(call.request.requestIdentifier);
    const payment = id ? this.incoming.get(id) : undefined;
    callback(null, {
      payments:
        payment?.state === 'PAID'
          ? [
              {
                paymentIdentifier: paymentIdentifier(payment.id),
                paymentAmount: payment.amount,
                paymentId: `settlement-${payment.id}`,
              },
            ]
          : [],
    });
  };

  private readonly checkOutgoingPayment: grpc.handleUnaryCall<
    CheckPaymentRequest,
    Record<string, unknown>
  > = (call, callback) => {
    this.observeProtocol(call);
    const quoteId = paymentIdentifierValue(call.request.requestIdentifier);
    const payment = quoteId ? this.outgoing.get(quoteId) : undefined;
    if (!payment) return callback(new Error(`Unknown outgoing payment: ${quoteId}`));
    callback(null, this.makePaymentResponse(payment));
  };

  private readonly waitPaymentEvent: grpc.handleServerStreamingCall<
    Record<string, never>,
    unknown
  > = (call) => {
    this.observeProtocol(call);
    this.streams.add(call);
    call.on('cancelled', () => this.streams.delete(call));
    call.on('close', () => this.streams.delete(call));
  };

  private makePaymentResponse(payment: OutgoingPayment): Record<string, unknown> {
    const status =
      payment.state === 'PAID'
        ? 'QUOTE_STATE_PAID'
        : payment.state === 'PENDING'
          ? 'QUOTE_STATE_PENDING'
          : 'QUOTE_STATE_UNPAID';
    return {
      paymentIdentifier: paymentIdentifier(payment.quoteId),
      paymentProof: payment.state === 'PAID' ? `proof-${payment.quoteId}` : undefined,
      status,
      totalSpent: {
        value: payment.state === 'PAID' ? payment.amount.value + payment.fee.value : 0,
        unit: payment.amount.unit,
      },
    };
  }
}
