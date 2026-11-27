import { isKeysetRejection } from '../infra/KeysetRejection.ts';
import type { Logger } from '../logging/Logger.ts';
import { normalizeMintUrl } from '../utils.ts';
import type { MintService } from './MintService.ts';
import type { WalletService } from './WalletService.ts';

/**
 * Fetches a mint's current keysets after the mint rejected one, so the next operation at that mint
 * prepares on keysets the mint accepts. The Wallet instances Coco builds never load keysets inside
 * an operation, so this refresh is how a rotation reaches them.
 *
 * An operation service calls it after it has stored its reaction to the rejected request, outside
 * any Wallet transaction. The refresh commits independently, is best effort, and never throws: a
 * failure is logged and changes nothing about the operation's outcome. Outputs allocated on the
 * rejected keyset stay consumed (ADR-0019).
 */
export class KeysetRejectionRefresh {
  constructor(
    private readonly deps: {
      mintService: Pick<MintService, 'refreshAndCommit'>;
      walletService: Pick<WalletService, 'clearCache'>;
      logger?: Logger;
    },
  ) {}

  /** Refresh the mint's metadata if `error` is the mint's keyset rejection; otherwise do nothing. */
  async refreshAfter(mintUrl: string, error: unknown): Promise<void> {
    if (!isKeysetRejection(error)) return;
    mintUrl = normalizeMintUrl(mintUrl);
    try {
      await this.deps.mintService.refreshAndCommit(mintUrl);
    } catch (refreshError) {
      this.deps.logger?.warn('Mint metadata refresh after a keyset rejection failed', {
        mintUrl,
        code: error.code,
        error: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
    } finally {
      // After the refresh, so a concurrent rebuild cannot cache the snapshot being replaced.
      this.deps.walletService.clearCache(mintUrl);
    }
  }
}
