import {
  normalizeMintIssuanceAttempt,
  normalizeMintUrl,
  parseMintIssuanceAttemptFailure,
  parseMintIssuanceAttemptMembers,
  parseMintIssuanceAttemptOutputData,
  serializeAmount,
  type MintIssuanceAttempt,
  type MintIssuanceAttemptRepository,
  type MintIssuanceAttemptTransition,
  type PreparedMintIssuanceAttempt,
} from '@cashu/coco-core/adapter';
import type { IdbDb, MintIssuanceAttemptRow } from '../lib/db.ts';

function attemptToRow(attempt: MintIssuanceAttempt): MintIssuanceAttemptRow {
  return {
    id: attempt.id,
    mintUrl: attempt.mintUrl,
    unit: attempt.unit,
    state: attempt.state,
    membersJson: JSON.stringify(
      attempt.members.map((member) => ({
        operationId: member.operationId,
        quoteId: member.quoteId,
        amount: serializeAmount(member.amount),
      })),
    ),
    memberOperationIds: attempt.members.map((member) => member.operationId),
    outputDataJson: JSON.stringify(attempt.outputData),
    createdAt: attempt.createdAt,
    submittedAt: attempt.submittedAt ?? null,
    terminalFailureJson: attempt.terminalFailure ? JSON.stringify(attempt.terminalFailure) : null,
  };
}

function rowToAttempt(row: MintIssuanceAttemptRow): MintIssuanceAttempt {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    unit: row.unit,
    members: parseMintIssuanceAttemptMembers(JSON.parse(row.membersJson)),
    outputData: parseMintIssuanceAttemptOutputData(JSON.parse(row.outputDataJson)),
    createdAt: row.createdAt,
  };

  if (row.state === 'prepared') {
    return normalizeMintIssuanceAttempt({ ...base, state: 'prepared' });
  }
  if (row.submittedAt == null) {
    throw new Error(`Mint issuance attempt ${row.id} is missing submittedAt`);
  }
  if (row.state === 'failed') {
    if (!row.terminalFailureJson) {
      throw new Error(`Failed Mint issuance attempt ${row.id} is missing terminal failure`);
    }
    return normalizeMintIssuanceAttempt({
      ...base,
      state: 'failed',
      submittedAt: row.submittedAt,
      terminalFailure: parseMintIssuanceAttemptFailure(JSON.parse(row.terminalFailureJson)),
    });
  }
  return normalizeMintIssuanceAttempt({
    ...base,
    state: row.state,
    submittedAt: row.submittedAt,
  });
}

/** IndexedDB persistence for immutable Mint Issuance Attempt recovery records. */
export class IdbMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  constructor(private readonly db: IdbDb) {}

  async create(input: PreparedMintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    if (attempt.state !== 'prepared') {
      throw new Error('Mint issuance attempts must be created in prepared state');
    }
    await this.db.runTransaction('rw', ['coco_cashu_mint_issuance_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_issuance_attempts');
      if (await table.get(attempt.id)) {
        throw new Error(`Mint issuance attempt already exists: ${attempt.id}`);
      }
      await table.add(attemptToRow(attempt));
    });
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const row = (await this.db.table('coco_cashu_mint_issuance_attempts').get(id)) as
      | MintIssuanceAttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getNewestByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const rows = (await this.db
      .table('coco_cashu_mint_issuance_attempts')
      .where('memberOperationIds')
      .equals(operationId)
      .toArray()) as MintIssuanceAttemptRow[];
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async listIncomplete(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    const rows = (await this.db
      .table('coco_cashu_mint_issuance_attempts')
      .where('state')
      .anyOf(['prepared', 'submitted'])
      .toArray()) as MintIssuanceAttemptRow[];
    return rows
      .filter((row) => !normalizedMintUrl || row.mintUrl === normalizedMintUrl)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(rowToAttempt);
  }

  async compareAndTransition(
    id: string,
    transition: MintIssuanceAttemptTransition,
  ): Promise<boolean> {
    return this.db.runTransaction('rw', ['coco_cashu_mint_issuance_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_issuance_attempts');
      const row = (await table.get(id)) as MintIssuanceAttemptRow | undefined;
      if (!row || row.state !== transition.from) return false;

      if (transition.from === 'prepared' && transition.to === 'submitted') {
        if (!Number.isFinite(transition.submittedAt)) {
          throw new Error('Submitted Mint issuance attempt submittedAt must be finite');
        }
        await table.put({ ...row, state: 'submitted', submittedAt: transition.submittedAt });
        return true;
      }
      if (transition.from === 'submitted' && transition.to === 'succeeded') {
        await table.put({ ...row, state: 'succeeded' });
        return true;
      }
      if (transition.from === 'submitted' && transition.to === 'failed') {
        const terminalFailure = parseMintIssuanceAttemptFailure(transition.terminalFailure);
        await table.put({
          ...row,
          state: 'failed',
          terminalFailureJson: JSON.stringify(terminalFailure),
        });
        return true;
      }
      throw new Error('Illegal Mint issuance attempt transition');
    });
  }
}
