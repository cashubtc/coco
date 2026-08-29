import type { Logger } from '../logging/Logger.ts';
import {
  KeysetSyncError,
  OperationRecoveryRequiredError,
  StaleKeysetError,
} from '../models/Error.ts';
import type { WalletService } from '../services/WalletService.ts';
import { MintScopedLock } from './MintScopedLock.ts';

export type StaleKeysetReconciliation<T> =
  | { status: 'rolled_back' }
  | { status: 'resolved'; value: T }
  | { status: 'recovery_required'; cause?: unknown };

export interface HandleStaleKeysetInput<T> {
  operationId: string;
  mintUrl: string;
  unit: string;
  cause: unknown;
  reconcile: () => Promise<StaleKeysetReconciliation<T>>;
}

export interface RefreshUnknownKeysetInput {
  operationId: string;
  mintUrl: string;
  unit: string;
  keysetId: string;
  cause: unknown;
}

/**
 * Coordinates the shared mint-snapshot boundary around operation-specific recovery.
 */
export class KeysetRotationService {
  constructor(
    private readonly walletService: WalletService,
    private readonly mintScopedLock: MintScopedLock,
    private readonly logger?: Logger,
  ) {}

  async handleStaleKeyset<T>(input: HandleStaleKeysetInput<T>): Promise<T> {
    const releaseMintLock = await this.mintScopedLock.acquire(input.mintUrl);
    try {
      try {
        await this.walletService.requireMintRefresh(input.mintUrl);
      } catch (cause) {
        throw this.recoveryRequired(input, 'Failed to persist the mint refresh requirement', cause);
      }

      let reconciliation: StaleKeysetReconciliation<T>;
      try {
        reconciliation = await input.reconcile();
      } catch (cause) {
        this.walletService.clearCache(input.mintUrl);
        throw this.recoveryRequired(input, 'Failed to reconcile the stale operation', cause);
      }

      if (reconciliation.status === 'recovery_required') {
        this.walletService.clearCache(input.mintUrl);
        throw this.recoveryRequired(
          input,
          'The stale operation outcome remains ambiguous',
          reconciliation.cause ?? input.cause,
        );
      }

      try {
        await this.walletService.refreshRequiredMint(input.mintUrl, input.unit);
      } catch (cause) {
        throw this.recoveryRequired(input, 'Failed to refresh the stale mint snapshot', cause);
      }

      if (reconciliation.status === 'resolved') {
        this.logger?.info('Stale keyset operation resolved during recovery', {
          operationId: input.operationId,
          mintUrl: input.mintUrl,
          unit: input.unit,
        });
        return reconciliation.value;
      }

      this.logger?.warn('Operation rolled back after stale keyset rejection', {
        operationId: input.operationId,
        mintUrl: input.mintUrl,
        unit: input.unit,
      });
      throw new StaleKeysetError(
        input.operationId,
        input.mintUrl,
        input.unit,
        undefined,
        input.cause,
      );
    } finally {
      releaseMintLock();
    }
  }

  async refreshUnknownKeyset(input: RefreshUnknownKeysetInput): Promise<never> {
    await this.refreshMintSnapshot(input);
    throw new KeysetSyncError(
      input.mintUrl,
      input.keysetId,
      `Keyset ${input.keysetId} was not present in the cached mint snapshot`,
      input.cause,
    );
  }

  async refreshMintSnapshot(
    input: Pick<RefreshUnknownKeysetInput, 'operationId' | 'mintUrl' | 'unit' | 'cause'>,
  ): Promise<void> {
    const releaseMintLock = await this.mintScopedLock.acquire(input.mintUrl);
    try {
      try {
        await this.walletService.requireMintRefresh(input.mintUrl);
        await this.walletService.refreshRequiredMint(input.mintUrl, input.unit);
      } catch (cause) {
        throw this.recoveryRequired(input, 'Failed to refresh the mint keysets', cause);
      }
    } finally {
      releaseMintLock();
    }
  }

  private recoveryRequired(
    input: Pick<HandleStaleKeysetInput<unknown>, 'operationId' | 'mintUrl' | 'unit'>,
    message: string,
    cause: unknown,
  ): OperationRecoveryRequiredError {
    this.logger?.error(message, {
      operationId: input.operationId,
      mintUrl: input.mintUrl,
      unit: input.unit,
      cause,
    });
    return new OperationRecoveryRequiredError(
      input.operationId,
      input.mintUrl,
      input.unit,
      message,
      cause,
    );
  }
}
