import type { Token } from '@cashu/cashu-ts';
import { getDecodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import type { MintService } from './MintService';
import type { WalletService } from './WalletService';
import type { ProofService } from './ProofService';
import type { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import type { Logger } from '../logging/Logger';
import { ProofValidationError, UnknownMintError } from '../models/Error';
import { mapProofToCoreProof } from '../utils';

export class TransactionService {
  private readonly mintService: MintService;
  private readonly walletService: WalletService;
  private readonly proofService: ProofService;
  private readonly eventBus: EventBus<CoreEvents>;
  private readonly logger?: Logger;

  constructor(
    mintService: MintService,
    walletService: WalletService,
    proofService: ProofService,
    eventBus: EventBus<CoreEvents>,
    logger?: Logger,
  ) {
    this.mintService = mintService;
    this.walletService = walletService;
    this.proofService = proofService;
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async receive(token: Token | string): Promise<void> {
    let mint: string;
    try {
      mint = typeof token === 'string' ? getTokenMetadata(token).mint : token.mint;
    } catch (err) {
      this.logger?.warn('Failed to decode token for receive', { err });
      throw new ProofValidationError('Invalid token');
    }

    const trusted = await this.mintService.isTrustedMint(mint);
    if (!trusted) {
      throw new UnknownMintError(`Mint ${mint} is not trusted`);
    }

    try {
      const { keysets } = await this.mintService.ensureUpdatedMint(mint);
      const { wallet } = await this.walletService.getWalletWithActiveKeysetId(mint);
      let proofs =
        typeof token === 'string' ? getDecodedToken(token, keysets).proofs : token.proofs;
      proofs = await this.proofService.prepareProofsForReceiving(proofs);
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
      const fees = wallet.getFeesForProofs(proofs);
      const { keep: outputData } = await this.proofService.createOutputsAndIncrementCounters(mint, {
        keep: receiveAmount - fees,
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
      await this.eventBus.emit('receive:created', { mintUrl: mint, token: { mint, proofs } });
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
    // Try exact send first (without fees)
    const exactProofs = await this.proofService.selectProofsToSend(mintUrl, amount, false);
    const exactAmount = exactProofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (exactAmount === amount && exactProofs.length > 0) {
      this.logger?.info('Exact amount match, skipping swap', {
        mintUrl,
        amountToSend: amount,
        proofCount: exactProofs.length,
      });
      await this.proofService.setProofState(
        mintUrl,
        exactProofs.map((proof) => proof.secret),
        'inflight',
      );
      const token = { mint: mintUrl, proofs: exactProofs };
      await this.eventBus.emit('send:created', { mintUrl, token });
      return token;
    }
    // If not exact send, include fees and perform swap
    const selectedProofs = await this.proofService.selectProofsToSend(mintUrl, amount, true);
    const fees = wallet.getFeesForProofs(selectedProofs);
    const selectedAmount = selectedProofs.reduce((acc, proof) => acc + proof.amount, 0);
    const outputData = await this.proofService.createOutputsAndIncrementCounters(mintUrl, {
      keep: selectedAmount - amount - fees,
      send: amount,
    });
    this.logger?.info('Sending with swap', {
      mintUrl,
      amountToSend: amount,
      fees,
      selectedAmount,
      proofCount: selectedProofs.length,
    });
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
}


