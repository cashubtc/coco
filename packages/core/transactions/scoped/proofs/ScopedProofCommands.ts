import { sameCoreProof } from '@core/proofs/ProofIdentity.ts';
import { selectProofsRGLI, type Amount, type SelectProofs, type Proof } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import { createKeyChain } from '@core/proofs/KeysetSelection.ts';
import type { ProofQueries } from '@core/proofs/ProofQueries.ts';
import { selectProofInputs, calculateProofFee } from '@core/proofs/ProofSelection.ts';
import type { KeysetRepository, ProofRepository } from '@core/repositories';
import type { CoreProof } from '@core/types.ts';

export interface OwnedProofs {
  mintUrl: string;
  unit: string;
  operationId: string;
  secrets: string[];
  state: CoreProof['state'] | readonly CoreProof['state'][];
  ownership?: 'used' | 'created';
}

export interface SelectAndReserveProofs {
  mintUrl: string;
  unit: string;
  operationId: string;
  amount: Amount;
  forceSwap: boolean;
}

export interface ScopedProofCommands extends ProofQueries {
  selectAndReserve(command: SelectAndReserveProofs): Promise<{
    proofs: CoreProof[];
    fee: Amount;
    needsSwap: boolean;
  }>;
  getFee(mintUrl: string, unit: string, proofs: readonly Proof[]): Promise<Amount>;
  /** Reconcile issued outputs without claiming or spending incoming token proofs. */
  reconcileIssued(command: {
    mintUrl: string;
    unit: string;
    operationId: string;
    proofs: CoreProof[];
  }): Promise<CoreProof[]>;
  getOwned(command: OwnedProofs): Promise<CoreProof[]>;
  markInflight(command: Omit<OwnedProofs, 'state' | 'ownership'>): Promise<void>;
  settleSpend(command: OwnedProofs & { outputs: CoreProof[] }): Promise<void>;
  recordSpent(command: Omit<OwnedProofs, 'state'>): Promise<void>;
  releaseOwned(mintUrl: string, operationId: string, secrets: string[]): Promise<void>;
}

/** Reusable reservation and settlement rules within the owning operation's adapter scope. */
export class RepositoryProofCommands implements ScopedProofCommands {
  constructor(
    private readonly proofs: ProofRepository,
    private readonly keysets: KeysetRepository,
    private readonly selectProofs: SelectProofs = selectProofsRGLI,
  ) {}

  async selectAndReserve(command: SelectAndReserveProofs) {
    const available = await this.proofs.getAvailableProofs(command.mintUrl, { unit: command.unit });
    const keysets = await this.keysets.getKeysetsByMintUrl(command.mintUrl);
    const selected = selectProofInputs(
      command,
      available,
      createKeyChain(command.mintUrl, command.unit, keysets),
      this.selectProofs,
      command.forceSwap,
    );
    const secrets = selected.proofs.map((proof) => proof.secret);
    if (new Set(secrets).size !== secrets.length) {
      throw new ProofValidationError('Proof selection contains duplicate inputs');
    }
    await this.proofs.reserveProofs(command.mintUrl, secrets, command.operationId);
    return { ...selected, proofs: selected.proofs as CoreProof[] };
  }

  async getFee(mintUrl: string, unit: string, proofs: readonly Proof[]): Promise<Amount> {
    return calculateProofFee(
      proofs,
      createKeyChain(mintUrl, unit, await this.keysets.getKeysetsByMintUrl(mintUrl)),
    );
  }

  async reconcileIssued(command: {
    mintUrl: string;
    unit: string;
    operationId: string;
    proofs: CoreProof[];
  }): Promise<CoreProof[]> {
    if (
      new Set(command.proofs.map((proof) => proof.secret)).size !== command.proofs.length ||
      command.proofs.some(
        (proof) =>
          proof.mintUrl !== command.mintUrl ||
          normalizeUnit(proof.unit) !== normalizeUnit(command.unit) ||
          proof.createdByOperationId !== command.operationId ||
          (proof.state !== 'ready' && proof.state !== 'spent'),
      )
    ) {
      throw new ProofValidationError('Issued proofs have invalid identity or state');
    }
    const existing = await this.proofs.getProofsBySecrets(
      command.mintUrl,
      command.proofs.map((proof) => proof.secret),
    );
    const bySecret = new Map(command.proofs.map((proof) => [proof.secret, proof]));
    for (const proof of existing) {
      const candidate = bySecret.get(proof.secret);
      if (!candidate || !sameCoreProof(proof, candidate)) {
        throw new ProofValidationError(
          `Issued output ${proof.secret} conflicts with an existing proof`,
        );
      }
    }
    const existingSecrets = new Set(existing.map((proof) => proof.secret));
    const missing = command.proofs.filter((proof) => !existingSecrets.has(proof.secret));
    if (missing.length > 0) await this.proofs.saveProofs(command.mintUrl, missing);
    // A complete Restore may establish that legacy partially saved outputs were spent.
    // Ready observations must never reset a proof's later local state or reservation.
    const spent = existing
      .filter((proof) => bySecret.get(proof.secret)?.state === 'spent')
      .map((proof) => proof.secret);
    if (spent.length > 0) await this.proofs.setProofState(command.mintUrl, spent, 'spent');
    return missing;
  }

  async getOwned(command: OwnedProofs): Promise<CoreProof[]> {
    if (new Set(command.secrets).size !== command.secrets.length) {
      throw new ProofValidationError('Operation contains duplicate input proofs');
    }
    const stored = await this.proofs.getProofsBySecrets(command.mintUrl, command.secrets);
    const bySecret = new Map(stored.map((proof) => [proof.secret, proof]));
    return command.secrets.map((secret) => {
      const proof = bySecret.get(secret);
      const owner =
        command.ownership === 'created' ? proof?.createdByOperationId : proof?.usedByOperationId;
      if (
        !proof ||
        owner !== command.operationId ||
        !(Array.isArray(command.state)
          ? command.state.includes(proof.state)
          : proof.state === command.state) ||
        proof.mintUrl !== command.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(command.unit)
      ) {
        throw new ProofValidationError(
          `Proof ${secret} is not ${command.state} and operation-owned`,
        );
      }
      return proof;
    });
  }

  async markInflight(command: Omit<OwnedProofs, 'state' | 'ownership'>): Promise<void> {
    await this.getOwned({ ...command, state: 'ready' });
    await this.proofs.setProofState(command.mintUrl, command.secrets, 'inflight');
  }

  async settleSpend(command: OwnedProofs & { outputs: CoreProof[] }): Promise<void> {
    await this.getOwned(command);
    for (const proof of command.outputs) {
      if (
        proof.mintUrl !== command.mintUrl ||
        normalizeUnit(proof.unit) !== normalizeUnit(command.unit)
      ) {
        throw new ProofValidationError('Settlement outputs have a different mint or unit');
      }
    }
    await this.proofs.saveProofs(command.mintUrl, command.outputs);
    await this.proofs.setProofState(command.mintUrl, command.secrets, 'spent');
  }

  async recordSpent(command: Omit<OwnedProofs, 'state'>): Promise<void> {
    await this.getOwned({ ...command, state: 'inflight' });
    await this.proofs.setProofState(command.mintUrl, command.secrets, 'spent');
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
