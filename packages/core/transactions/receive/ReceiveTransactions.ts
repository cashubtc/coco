import type { CoreTransactionRunner } from '../CoreTransaction.ts';
import type {
  ExecutingReceiveOperation,
  RolledBackReceiveOperation,
} from '@core/operations/receive/ReceiveOperation.ts';
import type {
  PrepareReceiveInput,
  ReceiveOperationInput,
  ClaimReceiveRecoveryInput,
  ApplyReceiveResultInput,
  FailReceiveInput,
  PreparedReceiveResult,
  AppliedReceiveResult,
} from './types.ts';

export interface ReceiveTransactions {
  prepare(input: PrepareReceiveInput): Promise<PreparedReceiveResult>;
  beginExecution(input: ReceiveOperationInput): Promise<ExecutingReceiveOperation>;
  claimRecovery(input: ClaimReceiveRecoveryInput): Promise<ExecutingReceiveOperation>;
  /** Returns null without writing when the combined local/remote evidence is incomplete. */
  applyResult(input: ApplyReceiveResultInput): Promise<AppliedReceiveResult | null>;
  failExecution(input: FailReceiveInput): Promise<RolledBackReceiveOperation>;
  cancel(
    input: ReceiveOperationInput & { reason: string },
  ): Promise<RolledBackReceiveOperation | null>;
  cleanupLegacyInit(operationId: string): Promise<void>;
}

/** Each command owns exactly one commit through the session's shared runner. */
export class CoreReceiveTransactions implements ReceiveTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(input: PrepareReceiveInput) {
    return this.runner.run((transaction) => transaction.receives.prepare(input));
  }
  beginExecution(input: ReceiveOperationInput) {
    return this.runner.run((transaction) => transaction.receives.beginExecution(input));
  }
  claimRecovery(input: ClaimReceiveRecoveryInput) {
    return this.runner.run((transaction) => transaction.receives.claimRecovery(input));
  }
  applyResult(input: ApplyReceiveResultInput) {
    return this.runner.run((transaction) => transaction.receives.applyResult(input));
  }
  failExecution(input: FailReceiveInput) {
    return this.runner.run((transaction) => transaction.receives.failExecution(input));
  }
  cancel(input: ReceiveOperationInput & { reason: string }) {
    return this.runner.run((transaction) => transaction.receives.cancel(input));
  }
  cleanupLegacyInit(operationId: string) {
    return this.runner.run((transaction) => transaction.receives.cleanupLegacyInit(operationId));
  }
}
