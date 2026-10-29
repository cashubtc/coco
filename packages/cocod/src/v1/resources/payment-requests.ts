import {
  evaluatePaymentRequestRequestSchema,
  paymentRequestEvaluationSchema,
} from '../resource-schemas.js';
import { withCocoErrors } from './errors.js';
import { defineResourceRoute, requireRunningSession } from './shared.js';

export const paymentRequestRoutes = [
  defineResourceRoute({
    method: 'POST',
    path: '/v1/payment-requests/evaluate',
    capability: 'wallet:read',
    summary: 'Evaluate what paying an outgoing Payment Request would require',
    requestSchema: evaluatePaymentRequestRequestSchema,
    responseSchema: paymentRequestEvaluationSchema,
    handler: async (input, _context, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const resolved = await withCocoErrors({ action: 'evaluate the Payment Request' }, () =>
        manager.paymentRequests.parse(input.request),
      );
      const condition = resolved.spendingCondition;
      return {
        ...(resolved.amount !== undefined ? { amount: resolved.amount.toString() } : {}),
        unit: resolved.unit,
        transport: { type: resolved.transport.type },
        allowedMints: [...resolved.allowedMints],
        payableMints: [...resolved.payableMints],
        ...(condition
          ? {
              spendingCondition:
                condition.kind === 'P2PK'
                  ? { kind: 'P2PK' as const }
                  : { kind: condition.kind, nut10Kind: condition.nut10Kind },
            }
          : {}),
      };
    },
  }),
];
