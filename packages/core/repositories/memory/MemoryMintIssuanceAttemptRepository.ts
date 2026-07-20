import type { MintIssuanceAttemptRepository } from '..';
import {
  applyMintIssuanceAttemptTransition,
  INCOMPLETE_MINT_ISSUANCE_ATTEMPT_STATES,
  normalizeMintIssuanceAttempt,
  type MintIssuanceAttempt,
  type MintIssuanceAttemptTransition,
  type PreparedMintIssuanceAttempt,
} from '../../operations/mint/MintIssuanceAttempt.ts';
import { normalizeMintUrl } from '../../utils.ts';

/** In-memory persistence for immutable Mint Issuance Attempt recovery records. */
export class MemoryMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  private attempts = new Map<string, MintIssuanceAttempt>();

  async create(input: PreparedMintIssuanceAttempt): Promise<void> {
    if (this.attempts.has(input.id)) {
      throw new Error(`Mint issuance attempt already exists: ${input.id}`);
    }
    const attempt = normalizeMintIssuanceAttempt(input);
    if (attempt.state !== 'prepared') {
      throw new Error('Mint issuance attempts must be created in prepared state');
    }
    this.attempts.set(attempt.id, attempt);
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const attempt = this.attempts.get(id);
    return attempt ? normalizeMintIssuanceAttempt(attempt) : null;
  }

  async getNewestByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const newest = Array.from(this.attempts.values())
      .filter((attempt) => attempt.members.some((member) => member.operationId === operationId))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0];
    return newest ? normalizeMintIssuanceAttempt(newest) : null;
  }

  async listIncomplete(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    return Array.from(this.attempts.values())
      .filter(
        (attempt) =>
          INCOMPLETE_MINT_ISSUANCE_ATTEMPT_STATES.includes(
            attempt.state as (typeof INCOMPLETE_MINT_ISSUANCE_ATTEMPT_STATES)[number],
          ) &&
          (!normalizedMintUrl || attempt.mintUrl === normalizedMintUrl),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(normalizeMintIssuanceAttempt);
  }

  async compareAndTransition(
    id: string,
    transition: MintIssuanceAttemptTransition,
  ): Promise<boolean> {
    const existing = this.attempts.get(id);
    if (!existing) return false;
    const transitioned = applyMintIssuanceAttemptTransition(existing, transition);
    if (!transitioned) return false;
    this.attempts.set(id, transitioned);
    return true;
  }
}
