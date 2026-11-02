import type { LifecycleOperationType } from '@cashu/coco-core';

import {
  enumNode,
  literalNode,
  namedSchema,
  objectNode,
  stringNode,
  unionNode,
} from '../schema-nodes.js';
import { historySchema, type HistoryDocument } from './wallet-schemas.js';

const timestampNode = stringNode({
  format: 'date-time',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
});
const identifierNode = stringNode({ minLength: 1, maxLength: 512 });
const mintUrlNode = stringNode({ format: 'uri', pattern: '^https?://', maxLength: 2048 });

/** Invalidation published on the event stream; clients refetch the named resource. */
export type ResourceEventDocument = { timestamp: string } & (
  | { type: 'history.updated'; data: HistoryDocument }
  | {
      type: 'operation.updated';
      data: {
        operationType: LifecycleOperationType;
        operationId: string;
        mintUrl: string;
      };
    }
  | {
      type: 'quote.updated';
      data: { quoteType: 'mint' | 'melt'; mintUrl: string; method: string; quoteId: string };
    }
  | { type: 'mint.updated'; data: { mintUrl: string } }
  | { type: 'balance.updated'; data: { mintUrl: string } }
);

export const resourceEventSchema = namedSchema<ResourceEventDocument>(
  'ResourceEvent',
  unionNode([
    objectNode({
      type: literalNode('history.updated'),
      timestamp: timestampNode,
      data: historySchema,
    }),
    objectNode({
      type: literalNode('operation.updated'),
      timestamp: timestampNode,
      data: objectNode({
        operationType: enumNode(['mint', 'melt', 'send', 'receive']),
        operationId: identifierNode,
        mintUrl: mintUrlNode,
      }),
    }),
    objectNode({
      type: literalNode('quote.updated'),
      timestamp: timestampNode,
      data: objectNode({
        quoteType: enumNode(['mint', 'melt']),
        mintUrl: mintUrlNode,
        method: stringNode(),
        quoteId: identifierNode,
      }),
    }),
    objectNode({
      type: literalNode('mint.updated'),
      timestamp: timestampNode,
      data: objectNode({ mintUrl: mintUrlNode }),
    }),
    objectNode({
      type: literalNode('balance.updated'),
      timestamp: timestampNode,
      data: objectNode({ mintUrl: mintUrlNode }),
    }),
  ]),
);
