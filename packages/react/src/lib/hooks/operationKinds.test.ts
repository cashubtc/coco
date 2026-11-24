import { Amount } from '@cashu/coco-core';
import type { InitSendOperation } from '@cashu/coco-core';
import { describe, expect, it } from 'vitest';
import { sendOperationKind } from './operationKinds';

const legacy: InitSendOperation = {
  id: 'send-op-ordering',
  state: 'init',
  mintUrl: 'https://mint.example',
  amount: Amount.from(1),
  unit: 'sat',
  method: 'default',
  methodData: {},
  createdAt: 10,
  updatedAt: 50,
};

describe('Send revision ordering', () => {
  it('orders by revision even when the older revision has a later timestamp', () => {
    const olderRevision = { ...legacy, revision: 2, updatedAt: 90 };
    const newerRevision = { ...legacy, revision: 3, updatedAt: 60 };

    expect(sendOperationKind.isOlder(olderRevision, newerRevision)).toBe(true);
    expect(sendOperationKind.isOlder(newerRevision, olderRevision)).toBe(false);
  });

  it('treats a missing legacy revision as zero and breaks ties by timestamp', () => {
    const earlier = { ...legacy, revision: 0, updatedAt: 40 };
    const later = { ...legacy, revision: 0, updatedAt: 60 };
    const nextRevision = { ...earlier, revision: 1 };

    expect(sendOperationKind.isOlder(earlier, legacy)).toBe(true);
    expect(sendOperationKind.isOlder(legacy, later)).toBe(true);
    expect(sendOperationKind.isOlder(nextRevision, legacy)).toBe(false);
  });
});
