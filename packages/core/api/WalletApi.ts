import type { Token } from '@cashu/cashu-ts';
import type {
  MintService,
  WalletService,
  ProofService,
  WalletRestoreService,
} from '@core/services';
import { getDecodedToken } from '@cashu/cashu-ts';
import { ProofValidationError, UnknownMintError } from '@core/models';
import { mapProofToCoreProof } from '@core/utils';
import type { Logger } from '../logging/Logger.ts';
import type { CoreEvents } from '@core/events/types.ts';
import type { EventBus } from '@core/events/EventBus.ts';

export class WalletApi {
  private mintService: MintService;
  private walletService: WalletService;
  private proofService: ProofService;
  private walletRestoreService: WalletRestoreService;
  private eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    walletRestoreService: WalletRestoreService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.walletRestoreService = walletRestoreService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async receive(token: Token | string) {
    let decoded: Token;
    try {
      decoded = typeof token === 'string' ? getDecodedToken(token) : token;
    } catch (err) {
      this.logger?.warn('Failed to decode token for receive', { err });
      throw new ProofValidationError('Invalid token');
    }

    const { mint, proofs } = decoded;

    const trusted = await this.mintService.isTrustedMint(mint);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mint} is not trusted`);
    }

    if (!Array.isArray(proofs) || proofs.length === 0) {
      this.logger?.warn('Token contains no proofs', { mint });
      throw new ProofValidationError('Token contains no proofs');
    }

    const receiveAmount = proofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (!Number.isFinite(receiveAmount) || receiveAmount <= 0) {
      this.logger?.warn('Token has invalid or non-positive amount', { mint, receiveAmount });
      throw new ProofValidationError('Token amount must be a positive integer');
    }

    this.logger?.info('Receiving token', { mint, proofs: proofs.length, amount: receiveAmount });

    try {
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mint);
      const { keep: outputData } = await this.proofService.createOutputsAndIncrementCounters(mint, {
        keep: receiveAmount,
        send: 0,
      });

      if (!outputData || outputData.length === 0) {
        this.logger?.error('Failed to create deterministic outputs for receive', {
          mint,
          amount: receiveAmount,
        });
        throw new Error('Failed to create outputs for receive');
      }

      const newProofs = await wallet.receive({ mint, proofs }, { outputData });
      await this.proofService.saveProofs(mint, mapProofToCoreProof(mint, 'ready', newProofs));
      await this.eventBus.emit('receive:created', { mintUrl: mint, token: decoded });
      this.logger?.debug('Token received and proofs saved', {
        mint,
        newProofs: newProofs.length,
      });
    } catch (err) {
      this.logger?.error('Failed to receive token', { mint, err });
      throw err;
    }
  }

  async send(mintUrl: string, amount: number): Promise<Token> {
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, amount);
    const fees = wallet.getFeesForProofs(selectedProofs);
    const selectedAmount = selectedProofs.reduce((acc, proof) => acc + proof.amount, 0);
    const outputData = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: selectedAmount - amount - fees,
      send: amount,
    });
    this.logger?.info('Sending...', { mintUrl, amountToSend: amount, fees, selectedAmount });
    const { send, keep } = await wallet.send(amount, selectedProofs, { outputData });
    await this.proofService.saveProofs(
      mintUrl,
      mapProofToCoreProof(mintUrl, 'ready', [...keep, ...send]),
    );
    await this.proofService.setProofState(
      mintUrl,
      selectedProofs.map((proof) => proof.secret),
      'spent',
    );
    await this.proofService.setProofState(
      mintUrl,
      send.map((proof) => proof.secret),
      'inflight',
    );
    const token = {
      mint: mintUrl,
      proofs: send,
    };
    await this.eventBus.emit('send:created', { mintUrl, token });
    return token;
  }

  async getBalances(): Promise<{ [mintUrl: string]: number }> {
    const proofs = await this.proofService.getAllReadyProofs();
    const balances: { [mintUrl: string]: number } = {};
    for (const proof of proofs) {
      const mintUrl = proof.mintUrl;
      const balance = balances[mintUrl] || 0;
      balances[mintUrl] = balance + proof.amount;
    }
    return balances;
  }

  // Restoration logic is delegated to WalletRestoreService

  async restore(mintUrl: string) {
    this.logger?.info('Starting restore', { mintUrl });
    const mint = await this.mintService.addMintByUrl(mintUrl, { trusted: true });
    this.logger?.debug('Mint fetched for restore', {
      mintUrl,
      keysetCount: mint.keysets.length,
    });
    const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mintUrl);
    const failedKeysetIds: { [keysetId: string]: Error } = {};
    for (const keyset of mint.keysets) {
      try {
        await this.walletRestoreService.restoreKeyset(mintUrl, wallet, keyset.id);
      } catch (error) {
        this.logger?.error('Keyset restore failed', { mintUrl, keysetId: keyset.id, error });
        failedKeysetIds[keyset.id] = error as Error;
      }
    }
    if (Object.keys(failedKeysetIds).length > 0) {
      this.logger?.error('Restore completed with failures', {
        mintUrl,
        failedKeysetIds: Object.keys(failedKeysetIds),
      });
      throw new Error('Failed to restore some keysets');
    }
    this.logger?.info('Restore completed successfully', { mintUrl });
  }
}
