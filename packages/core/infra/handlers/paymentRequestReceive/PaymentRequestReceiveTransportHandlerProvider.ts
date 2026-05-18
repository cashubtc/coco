import type { Amount, PaymentRequestTransport } from '@cashu/cashu-ts';

import { PaymentRequestError } from '../../../models/Error';
import type {
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveTransport,
} from '../../../operations/paymentRequestReceive/PaymentRequestReceiveOperation';

export interface PaymentRequestReceiveTransportCreateInput {
  requestId: string;
  amount: Amount;
  unit: string;
  mints: string[];
  description?: string;
  singleUse: boolean;
}

export interface PaymentRequestReceiveTransportHandler {
  readonly type: Exclude<PaymentRequestReceiveTransport, 'inband'>;
  createRequestTransport?(
    input: PaymentRequestReceiveTransportCreateInput,
  ): Promise<PaymentRequestTransport> | PaymentRequestTransport;
  activate(operation: PaymentRequestReceiveOperation): Promise<void> | void;
  deactivate(operation: PaymentRequestReceiveOperation): Promise<void> | void;
}

/**
 * Runtime registry for incoming payment request transport handlers.
 * Keeps transport wiring concerns out of the receive saga.
 */
export class PaymentRequestReceiveTransportHandlerProvider {
  private readonly registry = new Map<
    Exclude<PaymentRequestReceiveTransport, 'inband'>,
    PaymentRequestReceiveTransportHandler
  >();

  register(handler: PaymentRequestReceiveTransportHandler): () => void {
    if (this.registry.has(handler.type)) {
      throw new PaymentRequestError(
        `Payment request receive transport handler '${handler.type}' is already registered`,
      );
    }

    this.registry.set(handler.type, handler);
    return () => {
      if (this.registry.get(handler.type) === handler) {
        this.registry.delete(handler.type);
      }
    };
  }

  get(
    type: Exclude<PaymentRequestReceiveTransport, 'inband'>,
  ): PaymentRequestReceiveTransportHandler {
    const handler = this.registry.get(type);
    if (!handler) {
      throw new PaymentRequestError(
        `No payment request receive transport handler registered for '${type}'`,
      );
    }
    return handler;
  }

  getOptional(
    type: Exclude<PaymentRequestReceiveTransport, 'inband'>,
  ): PaymentRequestReceiveTransportHandler | undefined {
    return this.registry.get(type);
  }
}
