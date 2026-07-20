import type { MintOpsApi } from './MintOpsApi';
import type { MeltOpsApi } from './MeltOpsApi';
import type { ReceiveOpsApi } from './ReceiveOpsApi';
import type { SendOpsApi } from './SendOpsApi';
import type { MintSwapOpsApi } from './MintSwapOpsApi';

/**
 * Unified entry point for operation-based wallet workflows.
 *
 * This API groups the high-level send, receive, and melt operation APIs under a
 * single object so callers can discover and use the new operation-oriented
 * lifecycle consistently.
 */
export class OpsApi {
  /**
   * Send operations for preparing, executing, inspecting, refreshing, and
   * recovering token sends.
   */
  constructor(
    readonly send: SendOpsApi,
    /**
     * Receive operations for preparing, executing, inspecting, refreshing, and
     * recovering token receives.
     */
    readonly receive: ReceiveOpsApi,
    /**
     * Mint operations for preparing, executing, inspecting, and recovering
     * quote-backed mint flows.
     */
    readonly mint: MintOpsApi,
    /**
     * Melt operations for preparing, executing, inspecting, refreshing, and
     * recovering outbound payment flows such as bolt11 melts.
     */
    readonly melt: MeltOpsApi,
    /** Exact-receive cross-mint swap operations. */
    readonly mintSwap: MintSwapOpsApi,
  ) {}
}
