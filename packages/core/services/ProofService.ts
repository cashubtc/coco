import type { Proof } from '@cashu/cashu-ts';
import type { CoreProof } from '../types';
import type { CounterService } from './CounterService';
import type { ProofRepository } from '../repositories';
import { EventBus } from '../events/EventBus';
import type { CoreEvents } from '../events/types';
import { ProofOperationError, ProofValidationError } from '../models/Error';

export class ProofService {
  private readonly counterService: CounterService;
  private readonly proofRepository: ProofRepository;
  private readonly eventBus?: EventBus<CoreEvents>;

  constructor(
    counterService: CounterService,
    proofRepository: ProofRepository,
    eventBus?: EventBus<CoreEvents>,
  ) {
    this.counterService = counterService;
    this.proofRepository = proofRepository;
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
        try {
          await this.eventBus?.emit('proofs:saved', {
            mintUrl,
            keysetId,
            proofs: group,
          });
        } catch {
          // ignore event handler errors
        }
      }),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length > 0) {
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
    try {
      await this.eventBus?.emit('proofs:state-changed', {
        mintUrl,
        secrets,
        state,
      });
    } catch {
      // ignore event handler errors
    }
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!mintUrl || mintUrl.trim().length === 0) {
      throw new ProofValidationError('mintUrl is required');
    }
    if (!secrets || secrets.length === 0) return;
    await this.proofRepository.deleteProofs(mintUrl, secrets);
    try {
      await this.eventBus?.emit('proofs:deleted', { mintUrl, secrets });
    } catch {
      // ignore event handler errors
    }
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
