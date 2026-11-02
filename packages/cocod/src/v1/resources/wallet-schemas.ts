import type { LifecycleOperationType } from '@cashu/coco-core';

import {
  amountNode,
  arrayNode,
  booleanNode,
  enumNode,
  integerNode,
  jsonValueNode,
  namedSchema,
  nullableNode,
  objectNode,
  stringNode,
  unionNode,
  type SchemaNode,
} from '../schema-nodes.js';

import { assertHttpMintUrl, type PageDocument } from '../resource-schemas.js';

const timestampNode = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const identifierNode = stringNode({ minLength: 1, maxLength: 512 });
const unitNode = stringNode({ minLength: 1, maxLength: 32 });
const mintUrlNode = stringNode({ format: 'uri', pattern: '^https?://', maxLength: 2048 });

function pageNode(item: SchemaNode): SchemaNode {
  return objectNode({
    items: arrayNode(item),
    offset: integerNode({ minimum: 0 }),
    limit: integerNode({ minimum: 1 }),
  });
}

/** Request-side Mint URL: an absolute HTTP(S) URL that Coco normalizes. */
const mintUrlRequestNode: SchemaNode = {
  jsonSchema: mintUrlNode.jsonSchema,
  parse(value, path) {
    mintUrlNode.parse(value, path);
    assertHttpMintUrl(value as string, path);
    return value;
  },
};

/** Spendable, reserved, and total balance of one Mint and unit. */
export interface BalanceDocument {
  mintUrl: string;
  unit: string;
  spendable: string;
  reserved: string;
  total: string;
}

export interface BalancesDocument {
  items: BalanceDocument[];
}

export const balancesSchema = namedSchema<BalancesDocument>(
  'Balances',
  objectNode({
    items: arrayNode(
      objectNode({
        mintUrl: mintUrlNode,
        unit: unitNode,
        spendable: amountNode(),
        reserved: amountNode(),
        total: amountNode(),
      }),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Known Mints
// ---------------------------------------------------------------------------

/** Safe projection of a Known Mint. */
export interface KnownMintDocument {
  mintUrl: string;
  name: string;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnownMintsDocument {
  items: KnownMintDocument[];
}

export interface RegisterMintRequest {
  mintUrl: string;
  trusted?: boolean;
}

export interface MintTrustRequest {
  mintUrl: string;
}

/** Mint information as advertised by the Mint (NUT-06). */
export interface MintInformationDocument {
  mintUrl: string;
  info: Record<string, unknown>;
}

/** One enabled NUT-04 or NUT-05 method and unit advertised by a Known Mint. */
export interface PaymentMethodCapabilityDocument {
  operation: 'mint' | 'melt';
  nut: 4 | 5;
  method: string;
  unit: string;
  minAmount?: string | null;
  maxAmount?: string | null;
  options?: unknown;
}

export interface PaymentMethodCapabilitiesDocument {
  mintUrl: string;
  items: PaymentMethodCapabilityDocument[];
}

const knownMintNode = objectNode({
  mintUrl: mintUrlNode,
  name: stringNode(),
  trusted: booleanNode(),
  createdAt: timestampNode,
  updatedAt: timestampNode,
});

export const knownMintSchema = namedSchema<KnownMintDocument>('KnownMint', knownMintNode);

export const knownMintsSchema = namedSchema<KnownMintsDocument>(
  'KnownMints',
  objectNode({ items: arrayNode(knownMintNode) }),
);

export const registerMintRequestSchema = namedSchema<RegisterMintRequest>(
  'RegisterMintRequest',
  objectNode({ mintUrl: mintUrlRequestNode, trusted: booleanNode() }, { optional: ['trusted'] }),
);

export const mintTrustRequestSchema = namedSchema<MintTrustRequest>(
  'MintTrustRequest',
  objectNode({ mintUrl: mintUrlRequestNode }),
);

export const mintInformationSchema = namedSchema<MintInformationDocument>(
  'MintInformation',
  objectNode({ mintUrl: mintUrlNode, info: objectNode({}, { additionalProperties: true }) }),
);

export const paymentMethodCapabilitiesSchema = namedSchema<PaymentMethodCapabilitiesDocument>(
  'PaymentMethodCapabilities',
  objectNode({
    mintUrl: mintUrlNode,
    items: arrayNode(
      objectNode(
        {
          operation: enumNode(['mint', 'melt']),
          nut: unionNode([
            { jsonSchema: { const: 4 }, parse: (value, path) => constant(value, 4, path) },
            { jsonSchema: { const: 5 }, parse: (value, path) => constant(value, 5, path) },
          ]),
          method: stringNode(),
          unit: unitNode,
          minAmount: nullableNode(amountNode()),
          maxAmount: nullableNode(amountNode()),
          options: jsonValueNode(),
        },
        { optional: ['minAmount', 'maxAmount', 'options'] },
      ),
    ),
  }),
);

function constant<T extends number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new Error(`${path} must equal ${expected}`);
  return expected;
}

/** Safe projection of a Wallet history entry; it omits tokens, requests, and metadata. */
export interface HistoryDocument {
  id: string;
  type: LifecycleOperationType;
  source: 'operation' | 'legacy';
  operationId?: string;
  quoteId?: string;
  state: string;
  mintUrl: string;
  unit: string;
  amount: string;
  createdAt: string;
  updatedAt: string;
}

const historyNode = objectNode(
  {
    id: identifierNode,
    type: enumNode(['mint', 'melt', 'send', 'receive']),
    source: enumNode(['operation', 'legacy']),
    operationId: identifierNode,
    quoteId: identifierNode,
    state: stringNode(),
    mintUrl: stringNode(),
    unit: unitNode,
    amount: amountNode(),
    createdAt: timestampNode,
    updatedAt: timestampNode,
  },
  { optional: ['operationId', 'quoteId'] },
);

export const historySchema = namedSchema<HistoryDocument>('History', historyNode);

export const historyPageSchema = namedSchema<PageDocument<HistoryDocument>>(
  'HistoryPage',
  pageNode(historyNode),
);
