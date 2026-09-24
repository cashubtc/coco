import { selectProofsRGLI, type Amount, type SelectProofs } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import type { ProofQueries } from '@core/proofs/ProofQueries.ts';
import { selectProofInputs, calculateProofFee } from '@core/proofs/ProofSelection.ts';
import type { KeysetRepository, ProofRepository } from '@core/repositories';
import type { CoreProof } from '@core/types.ts';

export interface OwnedProofsInput {
  mintUrl: string;
  unit: string;
  operationId: string;
  secrets: string[];
  state: CoreProof['state'] | readonly CoreProof['state'][];
  ownership?: 'used' | 'created';
}

export interface SelectAndReserveProofsInput {
  mintUrl: string;
  unit: string;
  operationId: string;
  amount: Amount;
  forceSwap: boolean;
}

export interface TransactionProofs extends ProofQueries {
  saveCreated(mintUrl: string, proofs: CoreProof[]): Promise<void>;
  selectAndReserve(input: SelectAndReserveProofsInput): Promise<{
    proofs: CoreProof[];
    fee: Amount;
    needsSwap: boolean;
  }>;
  getFee(mintUrl: string, unit: string, proofs: readonly CoreProof[]): Promise<Amount>;
  getOwned(input: OwnedProofsInput): Promise<CoreProof[]>;
  markInflight(input: Omit<OwnedProofsInput, 'state'>): Promise<void>;
  /** The owning transition must establish that these inputs were never submitted or shared. */
  releaseUnsubmitted(input: Omit<OwnedProofsInput, 'state' | 'ownership'>): Promise<void>;
  settleSpend(input: OwnedProofsInput & { outputs: CoreProof[] }): Promise<void>;
  recordSpent(input: Omit<OwnedProofsInput, 'state'>): Promise<void>;
  releaseOwned(mintUrl: string, operationId: string, secrets: string[]): Promise<void>;
}

/** Reusable reservation and settlement rules within the owning operation's adapter scope. */
export class RepositoryTransactionProofs implements TransactionProofs {
  constructor(
    private readonly proofs: ProofRepository,
    private readonly keysets: KeysetRepository,
    private readonly selectProofs: SelectProofs = selectProofsRGLI,
  ) {}

  async saveCreated(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    const existing = await this.proofs.getProofsBySecrets(
      mintUrl,
      proofs.map((proof) => proof.secret),
    );
    for (const stored of existing) {
      const incoming = proofs.find((proof) => proof.secret === stored.secret)!;
      if (
        stored.id !== incoming.id ||
        !stored.amount.equals(incoming.amount) ||
        stored.C !== incoming.C ||
        stored.unit !== incoming.unit ||
        (stored.createdByOperationId != null &&
          stored.createdByOperationId !== incoming.createdByOperationId)
      ) {
        throw new ProofValidationError('Conflicting proof already exists for minted output');
      }
    }
    // Existing proofs may already be spent or reserved by a later operation. Never reset them.
    const secrets = new Set(existing.map((proof) => proof.secret));
    await this.proofs.saveProofs(
      mintUrl,
      proofs.filter((proof) => !secrets.has(proof.secret)),
    );
  }

  async selectAndReserve(input: SelectAndReserveProofsInput) {
    const available = await this.proofs.getAvailableProofs(input.mintUrl, { unit: input.unit });
    const keysets = await this.keysets.getKeysetsByMintUrl(input.mintUrl);
    const selected = selectProofInputs(
      input,
      available,
      createKeyChain(input.mintUrl, input.unit, keysets),
      this.selectProofs,
      input.forceSwap,
    );
    const secrets = selected.proofs.map((proof) => proof.secret);
    if (new Set(secrets).size !== secrets.length) {
      throw new ProofValidationError('Proof selection contains duplicate inputs');
    }
    await this.proofs.reserveProofs(input.mintUrl, secrets, input.operationId);
    return { ...selected, proofs: selected.proofs as CoreProof[] };
  }

  async getFee(mintUrl: string, unit: string, proofs: readonly CoreProof[]): Promise<Amount> {
    return calculateProofFee(
      proofs,
      createKeyChain(mintUrl, unit, await this.keysets.getKeysetsByMintUrl(mintUrl)),
    );
  }

  async getOwned(input: OwnedProofsInput): Promise<CoreProof[]> {
    if (new Set(input.secrets).size !== input.secrets.length) {
      throw new ProofValidationError('Operation contains duplicate input proofs');
    }
    const stored = await this.proofs.getProofsBySecrets(input.mintUrl, input.secrets);
    const bySecret = new Map(stored.map((proof) => [proof.secret, proof]));
    return input.secrets.map((secret) => {
      const proof = bySecret.get(secret);
      const owner =
        input.ownership === 'created' ? proof?.createdByOperationId : proof?.usedByOperationId;
      if (
        !proof ||
        owner !== input.operationId ||
        !(Array.isArray(input.state)
          ? input.state.includes(proof.state)
          : proof.state === input.state) ||
        proof.mintUrl !== input.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(input.unit)
      ) {
        throw new ProofValidationError(`Proof ${secret} is not ${input.state} and operation-owned`);
      }
      return proof;
    });
  }

  async markInflight(input: Omit<OwnedProofsInput, 'state'>): Promise<void> {
    const proofs = await this.getOwned({ ...input, state: 'ready' });
    if (
      proofs.some(
        (proof) => proof.usedByOperationId != null && proof.usedByOperationId !== input.operationId,
      )
    ) {
      throw new ProofValidationError('Cannot mark proofs reserved by another operation inflight');
    }
    await this.proofs.setProofState(input.mintUrl, input.secrets, 'inflight');
  }

  async releaseUnsubmitted(input: Omit<OwnedProofsInput, 'state' | 'ownership'>): Promise<void> {
    await this.getOwned({ ...input, state: ['ready', 'inflight'] });
    await this.proofs.setProofState(input.mintUrl, input.secrets, 'ready');
    await this.proofs.releaseProofs(input.mintUrl, input.secrets);
  }

  async settleSpend(input: OwnedProofsInput & { outputs: CoreProof[] }): Promise<void> {
    await this.getOwned(input);
    for (const proof of input.outputs) {
      if (
        proof.mintUrl !== input.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(input.unit)
      ) {
        throw new ProofValidationError('Settlement outputs have a different mint or unit');
      }
    }
    await this.proofs.saveProofs(input.mintUrl, input.outputs);
    await this.proofs.setProofState(input.mintUrl, input.secrets, 'spent');
  }

  async recordSpent(input: Omit<OwnedProofsInput, 'state'>): Promise<void> {
    await this.getOwned({ ...input, state: 'inflight' });
    await this.proofs.setProofState(input.mintUrl, input.secrets, 'spent');
  }

  async releaseOwned(mintUrl: string, operationId: string, secrets: string[]): Promise<void> {
    const stored = await this.proofs.getProofsBySecrets(mintUrl, secrets);
    if (
      stored.length !== new Set(secrets).size ||
      stored.some((proof) => proof.usedByOperationId !== operationId)
    ) {
      throw new ProofValidationError('Cannot release proofs owned by another operation');
    }
    await this.proofs.releaseProofs(mintUrl, secrets);
  }

  getProofsByOperationId(mintUrl: string, operationId: string) {
    return this.proofs.getProofsByOperationId(mintUrl, operationId);
  }

  getProofsBySecrets(mintUrl: string, secrets: string[]) {
    return this.proofs.getProofsBySecrets(mintUrl, secrets);
  }

  getReservedProofs() {
    return this.proofs.getReservedProofs();
  }
}
