import { OutputData, type OutputDataCreator, type Proof } from '@cashu/cashu-ts';
import type { Logger } from '../../logging/Logger.ts';
import { mintQuoteToMethodSnapshot, type MintQuote } from '../../models/MintQuote.ts';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
} from '../../operations/mint/MintOperation.ts';
import type { MintRemote } from '../../operations/mint/MintRemote.ts';
import type { MintService } from '../../services/MintService.ts';
import type { WalletService } from '../../services/WalletService.ts';
import { serializeOutputData } from '../../utils.ts';
import type { MintHandlerProvider } from '../handlers/mint/MintHandlerProvider.ts';
import type { MintAdapter } from '../MintAdapter.ts';

/** Retains the existing method-specific lifecycle while returning all candidates to the owner. */
export class HandlerMintRemote implements MintRemote {
  constructor(
    private readonly handlers: MintHandlerProvider,
    private readonly wallets: Pick<WalletService, 'getWalletWithActiveKeysetId'>,
    private readonly mints: Pick<MintService, 'isTrustedMint' | 'assertMethodUnitSupported'>,
    private readonly mintAdapter: MintAdapter,
    private readonly getSeed: () => Promise<Uint8Array>,
    readonly restoreOutputs: (operation: PendingOrLaterOperation) => Promise<Proof[]>,
    private readonly outputs: OutputDataCreator = OutputData,
    private readonly logger?: Logger,
  ) {}

  isTrusted(mintUrl: string) {
    return this.mints.isTrustedMint(mintUrl);
  }

  async prepare(operation: InitMintOperation, quote: MintQuote) {
    const handler = this.handlers.get(operation.method);
    await handler.validateQuoteForPrepare?.(quote);
    await this.mints.assertMethodUnitSupported(
      operation.mintUrl,
      4,
      operation.method,
      operation.method === 'onchain'
        ? operation.unit
        : { amount: operation.amount, unit: operation.unit },
    );
    const { keys, keysetId } = await this.wallets.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    const prepared = await handler.prepare({
      operation,
      importedQuote: mintQuoteToMethodSnapshot(quote),
    });
    const seed = await this.getSeed();
    return {
      operation: prepared,
      keysetId,
      derive: (counter: number) =>
        serializeOutputData({
          keep: this.outputs.createDeterministicData(prepared.amount, seed, counter, keys),
          send: [],
        }),
    };
  }

  async execute(operation: ExecutingMintOperation) {
    const { wallet } = await this.wallets.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return this.handlers.get(operation.method).execute({
      operation,
      wallet,
      mintAdapter: this.mintAdapter,
      logger: this.logger,
    });
  }

  async recoverExecuting(
    operation: ExecutingMintOperation,
    localClaimabilityFacts: Parameters<MintRemote['recoverExecuting']>[1],
  ) {
    const { wallet } = await this.wallets.getWalletWithActiveKeysetId(
      operation.mintUrl,
      operation.unit,
    );
    return this.handlers.get(operation.method).recoverExecuting({
      operation,
      wallet,
      mintAdapter: this.mintAdapter,
      logger: this.logger,
      localClaimabilityFacts,
      restoreOutputs: () => this.restoreOutputs(operation),
    });
  }

  observePending(operation: PendingMintOperation) {
    return this.handlers.get(operation.method).checkPending({
      operation,
      mintAdapter: this.mintAdapter,
      logger: this.logger,
    });
  }
}
