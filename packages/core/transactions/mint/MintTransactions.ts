import type { MintQuote } from '../../models/MintQuote.ts';
import type {
  AuthorizeMintInput,
  FailMintInput,
  MintCommands,
  PrepareMintInput,
  ReturnMintToPendingInput,
  SettleMintInput,
} from '../../operations/mint/MintCommands.ts';
import type { CoreTransactionRunner } from '../CoreTransaction.ts';

/** Every method owns one transaction and resolves only after its writes commit. */
export interface MintTransactions extends MintCommands {}

export class CoreMintTransactions implements MintTransactions {
  constructor(private readonly runner: CoreTransactionRunner) {}

  prepare(input: PrepareMintInput) {
    return this.runner.run((transaction) => transaction.mints.prepare(input));
  }

  authorize(input: AuthorizeMintInput) {
    return this.runner.run((transaction) => transaction.mints.authorize(input));
  }

  settle(input: SettleMintInput) {
    return this.runner.run((transaction) => transaction.mints.settle(input));
  }

  returnToPending(input: ReturnMintToPendingInput) {
    return this.runner.run((transaction) => transaction.mints.returnToPending(input));
  }

  fail(input: FailMintInput) {
    return this.runner.run((transaction) => transaction.mints.fail(input));
  }

  observeQuote(quote: MintQuote) {
    return this.runner.run((transaction) => transaction.mints.observeQuote(quote));
  }

  deleteInit(operationId: string) {
    return this.runner.run((transaction) => transaction.mints.deleteInit(operationId));
  }
}
