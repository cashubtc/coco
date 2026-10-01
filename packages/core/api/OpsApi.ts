import type { MintOpsApi } from './MintOpsApi';
import type { MeltOpsApi } from './MeltOpsApi';
import type { ReceiveOpsApi } from './ReceiveOpsApi';
import type { SendOpsApi } from './SendOpsApi';

/**
 * Operation interfaces grouped under `manager.ops`.
 */
export interface OpsApi {
  /**
   * Send operations for preparing, executing, inspecting, refreshing, and
   * recovering token sends.
   */
  readonly send: SendOpsApi;
  /**
   * Receive operations for preparing, executing, inspecting, refreshing, and
   * recovering token receives.
   */
  readonly receive: ReceiveOpsApi;
  /**
   * Mint operations for preparing, executing, inspecting, and recovering
   * quote-backed mint flows.
   */
  readonly mint: MintOpsApi;
  /**
   * Melt operations for preparing, executing, inspecting, refreshing, and
   * recovering outbound payment flows such as bolt11 melts.
   */
  readonly melt: MeltOpsApi;
}
