import type { Proof } from '@cashu/cashu-ts';
import type { CoreProof } from '../types';
import type { CounterService } from './CounterService';
import type { ProofRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import { ProofOperationError, ProofValidationError } from '../models/Error';
import { WalletService } from './WalletService';
import type { Logger } from '../logging/Logger.ts';

export class ProofService {
  private readonly counterService: CounterService;
  private readonly proofRepository: ProofRepository;
  private readonly eventBus?: EventBus<CoreEvents>;
  private readonly walletService: WalletService;
  private readonly logger?: Logger;
  constructor(
    counterService: CounterService,
    proofRepository: ProofRepository,
    walletService: WalletService,
    logger?: Logger,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.counterService = counterService;
    this.walletService = walletService;
    this.proofRepository = proofRepository;
    this.logger = logger;
    this.eventBus = eventBus;
  }

  async saveProofsAndIncrementCounters(mintUrl: string, proofs: Proof[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!Array.isArray(proofs) || proofs.length === 0) return;

    const groupedByKeyset = this.groupProofsByKeysetId(proofs);

    const results = await Promise.allSettled(
      Array.from(groupedByKeyset.entries()).map(async ([keysetId, group]) => {
        await this.proofRepository.saveProofs(mintUrl, group);
        await this.counterService.incrementCounter(mintUrl, keysetId, group.length);
        await this.eventBus?.emit('proofs:saved', {
          mintUrl,
          keysetId,
          proofs: group,
        });
        this.logger?.info('Proofs saved', { mintUrl, keysetId, count: group.length });
      }),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
      this.logger?.error('Failed to persist some proofs', { mintUrl, failed: failed.length });
      throw new ProofOperationError(
        mintUrl,
        `Failed to persist proofs for ${failed.length} keyset group(s)`,
      );
    }
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    return this.proofRepository.getReadyProofs(mintUrl);
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    return this.proofRepository.getAllReadyProofs();
  }

  async setProofState(
    mintUrl: string,
    secrets: string[],
    state: 'inflight' | 'ready',
  ): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;
    await this.proofRepository.setProofState(mintUrl, secrets, state);
    await this.eventBus?.emit('proofs:state-changed', {
      mintUrl,
      secrets,
      state,
    });
    this.logger?.debug('Proof state updated', { mintUrl, count: secrets.length, state });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;
    await this.proofRepository.deleteProofs(mintUrl, secrets);
    await this.eventBus?.emit('proofs:deleted', { mintUrl, secrets });
    this.logger?.info('Proofs deleted', { mintUrl, count: secrets.length });
  }

  async selectProofsToSend(mintUrl: string, amount: number): Promise<Proof[]> {
    const proofs = await this.getReadyProofs(mintUrl);
    const totalAmount = proofs.reduce((acc, proof) => acc + proof.amount, 0);
    if (totalAmount < amount) {
      throw new ProofValidationError('Not enough proofs to send');
    }
    const cashuWallet = await this.walletService.getWallet(mintUrl);
    const selectedProofs = cashuWallet.selectProofsToSend(proofs, amount);
    this.logger?.debug('Selected proofs to send', {
      mintUrl,
      amount,
      selectedProofs,
      count: selectedProofs.send.length,
    });
    return selectedProofs.send;
  }
  private groupProofsByKeysetId(proofs: Proof[]): Map<string, Proof[]> {
    const map = new Map<string, Proof[]>();
    for (const proof of proofs) {
      if (!proof.secret) throw new ProofValidationError('Proof missing secret');
      const keysetId = proof.id;
      if (!keysetId || keysetId.trim().length === 0) {
        throw new ProofValidationError('Proof missing keyset id');
      }
      const existing = map.get(keysetId);
      if (existing) {
        existing.push(proof);
      } else {
        map.set(keysetId, [proof]);
      }
    }
    return map;
  }
}
