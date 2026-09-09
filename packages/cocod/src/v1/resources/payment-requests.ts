import {
  defineV1Route,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
} from '../contract.js';
import {
  evaluatePaymentRequestRequestSchema,
  paymentRequestEvaluationSchema,
  type EvaluatePaymentRequestRequest,
  type PaymentRequestEvaluationDocument,
} from '../schema.js';
import { requireRunningSession } from './session.js';
import { paymentRequestCocoError } from './errors.js';

const EVALUATE_PAYMENT_REQUEST_ROUTE = {
  method: 'POST',
  path: '/v1/payment-requests/evaluate',
  capability: 'wallet:read',
  requestSchema: evaluatePaymentRequestRequestSchema,
  responseSchema: paymentRequestEvaluationSchema,
} as const satisfies V1RouteMetadata<
  EvaluatePaymentRequestRequest,
  PaymentRequestEvaluationDocument
>;

function toPaymentRequestEvaluationDocument(request: {
  amount?: { toString(): string };
  unit: string;
  transport: { type: 'inband' | 'http' | 'nostr' };
  allowedMints: string[];
  payableMints: string[];
  spendingCondition?:
    | { kind: 'P2PK' }
    | { kind: 'unsupported'; nut10Kind: string }
    | { kind: 'malformed'; nut10Kind: string };
}): PaymentRequestEvaluationDocument {
  const spendingCondition = request.spendingCondition;
  return {
    ...(request.amount !== undefined ? { amount: request.amount.toString() } : {}),
    unit: request.unit,
    transport: { type: request.transport.type },
    allowedMints: [...request.allowedMints],
    payableMints: [...request.payableMints],
    ...(spendingCondition !== undefined
      ? {
          spendingCondition:
            spendingCondition.kind === 'P2PK'
              ? { kind: spendingCondition.kind }
              : {
                  kind: spendingCondition.kind,
                  nut10Kind: spendingCondition.nut10Kind,
                },
        }
      : {}),
  };
}

export const paymentRequestsMetadata = [EVALUATE_PAYMENT_REQUEST_ROUTE];

export function createPaymentRequestsRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const evaluatePaymentRequest = defineV1Route({
    ...EVALUATE_PAYMENT_REQUEST_ROUTE,
    handler: async (input) => {
      const paymentRequests = requireRunningSession(runtime).manager.paymentRequests;
      try {
        return toPaymentRequestEvaluationDocument(await paymentRequests.parse(input.request));
      } catch (error) {
        throw paymentRequestCocoError('evaluate the Payment Request', error);
      }
    },
  });
  return [evaluatePaymentRequest];
}
