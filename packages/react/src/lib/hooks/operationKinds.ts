import type { CoreEvents, SendOperation } from '@cashu/coco-core';
import type { OperationKind } from './operationStore';

const SEND_EVENTS = [
  'send:prepared',
  'send:pending',
  'send:finalized',
  'send:rolled-back',
] as const satisfies readonly (keyof CoreEvents)[];

/**
 * Send records carry a persistence revision that core advances on every transition. A missing
 * legacy revision counts as zero. Equal revisions fall back to `updatedAt`, which keeps the
 * previous ordering for records written before revisions existed.
 */
export const sendOperationKind: OperationKind<SendOperation> = {
  name: 'send',
  read: (manager, operationId) => manager.ops.send.get(operationId),
  subscribe: (manager, onObserved) => {
    const unsubscribes = SEND_EVENTS.map((event) =>
      manager.on(event, ({ operation }) => onObserved(operation)),
    );
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  },
  isOlder: (incoming, current) => {
    const incomingRevision = incoming.revision ?? 0;
    const currentRevision = current.revision ?? 0;
    if (incomingRevision !== currentRevision) {
      return incomingRevision < currentRevision;
    }
    return incoming.updatedAt < current.updatedAt;
  },
};
