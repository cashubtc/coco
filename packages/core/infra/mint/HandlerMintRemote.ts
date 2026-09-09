import type { Logger } from '../../logging/Logger.ts';
import type { MintMetadata } from '../../mints/MintMetadata.ts';
import { assertMethodUnitCapability } from '../../mints/MintCapabilities.ts';
import { mintQuoteToMethodSnapshot, type MintQuote } from '../../models/MintQuote.ts';
import type {
  ExecutingMintOperation,
  InitMintOperation,
  PendingMintOperation,
  PendingOrLaterOperation,
} from '../../operations/mint/MintOperation.ts';
import type { MintRemote } from '../../operations/mint/MintRemote.ts';
import type { MintHandlerProvider } from '../handlers/mint/MintHandlerProvider.ts';
import type { MintAdapter } from '../MintAdapter.ts';
import { restoreOutputProofs } from '../ProofRestore.ts';
import type { MintWalletFactory } from './MintWallet.ts';

/** Method policy and protocol effects using snapshots; no Services or persistence authority. */
export class HandlerMintRemote implements MintRemote {
  constructor(
    private readonly handlers: MintHandlerProvider,
    private readonly wallets: Pick<MintWalletFactory, 'create'>,
    private readonly mintAdapter: MintAdapter,
    private readonly logger?: Logger,
  ) {}

  async prepare(
    operation: InitMintOperation,
    quote: MintQuote,
    metadata: MintMetadata,
    seed: Uint8Array,
  ) {
    const handler = this.handlers.get(operation.method);
    await handler.validateQuoteForPrepare?.(quote);
    assertMethodUnitCapability(
      metadata.mint.mintInfo,
      4,
      operation.method,
      operation.method === 'onchain'
        ? operation.unit
        : { amount: operation.amount, unit: operation.unit },
    );
    const wallet = this.wallets.create(metadata, operation.unit);
    const activeKeys = wallet.keyChain.getCheapestKeyset().toMintKeys();
    if (!activeKeys) throw new Error('Active mint keyset has no keys');
    const prepared = await handler.prepare({
      operation,
      importedQuote: mintQuoteToMethodSnapshot(quote),
    });
    return { operation: prepared, activeKeys, seed };
  }

  async execute(operation: ExecutingMintOperation, metadata: MintMetadata) {
    return this.handlers.get(operation.method).execute({
      operation,
      wallet: this.wallets.create(metadata, operation.unit),
      mintAdapter: this.mintAdapter,
      logger: this.logger,
    });
  }

  async recoverExecuting(
    operation: ExecutingMintOperation,
    localClaimabilityFacts: Parameters<MintRemote['recoverExecuting']>[1],
    metadata: MintMetadata,
  ) {
    return this.handlers.get(operation.method).recoverExecuting({
      operation,
      wallet: this.wallets.create(metadata, operation.unit),
      mintAdapter: this.mintAdapter,
      logger: this.logger,
      localClaimabilityFacts,
      restoreOutputs: () => this.restoreOutputs(operation, metadata),
    });
  }

  observePending(operation: PendingMintOperation) {
    return this.handlers.get(operation.method).checkPending({
      operation,
      mintAdapter: this.mintAdapter,
      logger: this.logger,
    });
  }

  restoreOutputs(operation: PendingOrLaterOperation, metadata: MintMetadata) {
    return restoreOutputProofs(
      this.wallets.create(metadata, operation.unit),
      metadata.keysets,
      operation.unit,
      operation.outputData,
    );
  }
}
