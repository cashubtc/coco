import { noBodySchema } from '../schema.js';
import { balancesSchema } from '../resource-schemas.js';
import { withCocoErrors } from './errors.js';
import {
  defineResourceRoute,
  queryBoolean,
  queryMintUrls,
  queryStrings,
  requireRunningSession,
} from './shared.js';

export const balanceRoutes = [
  defineResourceRoute({
    method: 'GET',
    path: '/v1/balances',
    capability: 'wallet:read',
    summary: 'Spendable, reserved, and total balances by Mint and unit',
    requestSchema: noBodySchema,
    responseSchema: balancesSchema,
    parameters: {
      mintUrl: queryMintUrls('Restrict balances to these Known Mints.'),
      unit: queryStrings('Restrict balances to these units.'),
      trustedOnly: queryBoolean('Restrict balances to trusted Known Mints.'),
    },
    handler: async (_input, { params }, { runtime }) => {
      const { manager } = requireRunningSession(runtime);
      const balances = await withCocoErrors({ action: 'read Wallet balances' }, () =>
        manager.wallet.balances.byMintAndUnit({
          ...(params.mintUrl.length > 0 ? { mintUrls: params.mintUrl } : {}),
          ...(params.unit.length > 0 ? { units: params.unit } : {}),
          ...(params.trustedOnly !== undefined ? { trustedOnly: params.trustedOnly } : {}),
        }),
      );
      return {
        items: Object.entries(balances).flatMap(([mintUrl, byUnit]) =>
          Object.entries(byUnit).map(([unit, balance]) => ({
            mintUrl,
            unit,
            spendable: balance.spendable.toString(),
            reserved: balance.reserved.toString(),
            total: balance.total.toString(),
          })),
        ),
      };
    },
  }),
];
