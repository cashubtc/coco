import { defineResourceRoute } from '../resource.js';
import {
  evaluatePaymentRequestRequestSchema,
  paymentRequestEvaluationSchema,
  type PaymentRequestEvaluationDocument,
} from '../schema.js';
import { paymentRequestCocoError } from './errors.js';
import { requireRunningSession } from './session.js';

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

export const paymentRequestsRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/payment-requests/evaluate',
    capability: 'wallet:read',
    requestSchema: evaluatePaymentRequestRequestSchema,
    responseSchema: paymentRequestEvaluationSchema,
    handler: async (input, _request, { runtime }) => {
      const paymentRequests = requireRunningSession(runtime).manager.paymentRequests;
      try {
        return toPaymentRequestEvaluationDocument(await paymentRequests.parse(input.request));
      } catch (error) {
        throw paymentRequestCocoError('evaluate the Payment Request', error);
      }
    },
  }),
];
