import { normalizeMintUrl, type BalanceQuery } from '@cashu/coco-core';
import { cocoError } from './errors.js';
import {
  defineV1Route,
  V1HttpError,
  type V1Runtime,
  type V1RouteDefinition,
  type V1RouteMetadata,
  type V1RouteParameter,
} from '../contract.js';
import { balancesSchema, noBodySchema, type BalancesDocument } from '../schema.js';
import { requireRunningSession } from './session.js';
import { TRUSTED_ONLY_QUERY_PARAMETER, parseQuery, queryParameterNames } from './parameters.js';

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

const BALANCES_ROUTE = {
  method: 'GET',
  path: '/v1/balances',
  capability: 'wallet:read',
  requestSchema: noBodySchema,
  responseSchema: balancesSchema,
  successStatuses: [200],
  idempotencyKey: null,
  responseCacheControl: null,
  parameters: BALANCE_PARAMETERS,
} as const satisfies V1RouteMetadata<null, BalancesDocument>;

function parseBalanceScope(request: Request): BalanceQuery {
  const query = parseQuery(
    request,
    queryParameterNames(BALANCES_ROUTE.parameters),
    'The balance filters are invalid',
  );

  const rawMintUrls = query.getAll('mintUrl');
  let mintUrls: string[];
  try {
    mintUrls = rawMintUrls.map((mintUrl) => {
      if (mintUrl.length === 0) {
        throw new Error('Mint URL is empty');
      }
      const parsed = new URL(mintUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('Mint URL must use HTTP or HTTPS');
      }
      return normalizeMintUrl(mintUrl);
    });
  } catch (error) {
    throw invalidBalanceQuery(error);
  }

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

export const balancesMetadata = [BALANCES_ROUTE];

export function createBalancesRoutes(runtime: V1Runtime): V1RouteDefinition[] {
  const balances = defineV1Route({
    ...BALANCES_ROUTE,
    handler: async (_input, request) => {
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
  });
  return [balances];
}
