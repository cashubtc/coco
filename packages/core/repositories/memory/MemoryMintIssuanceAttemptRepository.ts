import type { MintIssuanceAttemptRepository } from '..';
import {
  assertMintIssuanceAttemptRecoveryMaterialUnchanged,
  normalizeMintIssuanceAttempt,
  RECOVERABLE_MINT_ISSUANCE_ATTEMPT_STATES,
  type MintIssuanceAttempt,
} from '../../operations/mint/MintIssuanceAttempt.ts';
import { normalizeMintUrl } from '../../utils.ts';

export class MemoryMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  private attempts = new Map<string, MintIssuanceAttempt>();

  async create(attempt: MintIssuanceAttempt): Promise<void> {
    if (this.attempts.has(attempt.id)) {
      throw new Error(`Mint issuance attempt already exists: ${attempt.id}`);
    }
    this.attempts.set(attempt.id, normalizeMintIssuanceAttempt(attempt));
  }

  async update(attempt: MintIssuanceAttempt): Promise<void> {
    const existing = this.attempts.get(attempt.id);
    if (!existing) {
      throw new Error(`Mint issuance attempt not found: ${attempt.id}`);
    }
    assertMintIssuanceAttemptRecoveryMaterialUnchanged(existing, attempt);
    this.attempts.set(attempt.id, normalizeMintIssuanceAttempt(attempt));
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const attempt = this.attempts.get(id);
    return attempt ? normalizeMintIssuanceAttempt(attempt) : null;
  }

  async getByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const attempts = Array.from(this.attempts.values())
      .filter((attempt) => attempt.memberOperationIds.includes(operationId))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return attempts[0] ? normalizeMintIssuanceAttempt(attempts[0]) : null;
  }

  async listRecoverable(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    return Array.from(this.attempts.values())
      .filter(
        (attempt) =>
          RECOVERABLE_MINT_ISSUANCE_ATTEMPT_STATES.includes(
            attempt.state as (typeof RECOVERABLE_MINT_ISSUANCE_ATTEMPT_STATES)[number],
          ) &&
          (!normalizedMintUrl || attempt.mintUrl === normalizedMintUrl),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(normalizeMintIssuanceAttempt);
  }
}
