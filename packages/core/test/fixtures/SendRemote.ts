import { mock } from 'bun:test';
import type { SendRemote, SendRemoteSession } from '../../operations/send/SendRemote.ts';

/** In-memory protocol boundary; persistence stays in the real transaction runner. */
export function createSendRemoteDouble() {
  const session = {
    swap: mock<SendRemoteSession['swap']>(async () => ({ send: [], keep: [] })),
    checkProofStates: mock<SendRemoteSession['checkProofStates']>(async () => []),
    restoreOutputs: mock<SendRemoteSession['restoreOutputs']>(async () => []),
    reclaim: mock<SendRemoteSession['reclaim']>(async () => []),
  };
  return {
    ...session,
    open: mock<SendRemote['open']>(() => session),
  };
}
