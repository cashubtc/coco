import type { KeysetRejectionRefresh } from '../../services/KeysetRejectionRefresh.ts';

/**
 * For services built without a mint that can answer a keyset rejection. The refresh that follows a
 * rejection is covered over a real Manager and an in-process mint in `KeysetRejection.test.ts`.
 */
export const noKeysetRejectionRefresh: Pick<KeysetRejectionRefresh, 'refreshAfter'> = {
  refreshAfter: async () => {},
};
