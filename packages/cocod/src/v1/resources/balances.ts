import { type BalanceQuery } from '@cashu/coco-core';
import { V1HttpError, type V1RouteParameter } from '../contract.js';
import { defineResourceRoute } from '../resource.js';
import { balancesSchema, noBodySchema } from '../schema.js';
import { cocoError } from './errors.js';
import {
  TRUSTED_ONLY_QUERY_PARAMETER,
  parseMintUrl,
  parseQuery,
  queryParameterNames,
} from './parameters.js';
import { requireRunningSession } from './session.js';

const BALANCE_PARAMETERS = [
  {
    name: 'mintUrl',
    in: 'query',
    required: false,
    style: 'form',
    explode: true,
    schema: {
      type: 'array',
      items: { type: 'string', format: 'uri', pattern: '^https?://' },
    },
  },
  {
    name: 'unit',
    in: 'query',
    required: false,
    style: 'form',
    explode: true,
    schema: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  TRUSTED_ONLY_QUERY_PARAMETER,
] as const satisfies readonly V1RouteParameter[];

function parseBalanceScope(request: Request): BalanceQuery {
  const query = parseQuery(
    request,
    queryParameterNames(BALANCE_PARAMETERS),
    'The balance filters are invalid',
  );

  const mintUrls = query
    .getAll('mintUrl')
    .map((url) => parseMintUrl(url, 'The balance filters are invalid'));

  const units = query.getAll('unit');
  if (units.some((unit) => unit.length === 0)) {
    throw invalidBalanceQuery();
  }

  const trustedOnlyValues = query.getAll('trustedOnly');
  if (
    trustedOnlyValues.length > 1 ||
    trustedOnlyValues.some((value) => value !== 'true' && value !== 'false')
  ) {
    throw invalidBalanceQuery();
  }

  return {
    ...(mintUrls.length > 0 ? { mintUrls } : {}),
    ...(units.length > 0 ? { units } : {}),
    ...(trustedOnlyValues.length === 1 ? { trustedOnly: trustedOnlyValues[0] === 'true' } : {}),
  };
}

function invalidBalanceQuery(cause?: unknown): V1HttpError {
  return new V1HttpError({
    status: 400,
    code: 'invalid_request',
    message: 'The balance filters are invalid',
    retryable: false,
    cause,
  });
}

export const balancesRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/balances',
    capability: 'wallet:read',
    requestSchema: noBodySchema,
    responseSchema: balancesSchema,
    parameters: BALANCE_PARAMETERS,
    handler: async (_input, request, { runtime }) => {
      const session = requireRunningSession(runtime);
      const scope = parseBalanceScope(request);

      try {
        const byMintAndUnit = await session.manager.wallet.balances.byMintAndUnit(scope);
        return {
          items: Object.entries(byMintAndUnit).flatMap(([mintUrl, byUnit]) =>
            Object.entries(byUnit).map(([unit, balance]) => ({
              mintUrl,
              unit,
              spendable: balance.spendable.toString(),
              reserved: balance.reserved.toString(),
              total: balance.total.toString(),
            })),
          ),
        };
      } catch (error) {
        throw cocoError('return Wallet balances', error);
      }
    },
  }),
];
