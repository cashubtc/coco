import {
  deserializeAmount,
  normalizeMintIssuanceAttempt,
  normalizeMintUrl,
  parseMintIssuanceAttemptFailure,
  parseMintIssuanceAttemptOutputData,
  serializeAmount,
  type MintIssuanceAttempt,
  type MintIssuanceAttemptRepository,
  type MintIssuanceAttemptState,
  type MintIssuanceAttemptTransition,
  type PreparedMintIssuanceAttempt,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';

interface AttemptRow {
  id: string;
  mintUrl: string;
  unit: string;
  state: MintIssuanceAttemptState;
  outputDataJson: string;
  createdAt: number;
  submittedAt: number | null;
  terminalFailureJson: string | null;
}

interface MemberRow {
  operationId: string;
  quoteId: string;
  amount: string | number;
}

function rowToAttempt(row: AttemptRow, members: MemberRow[]): MintIssuanceAttempt {
  const base = {
    id: row.id,
    mintUrl: row.mintUrl,
    unit: row.unit,
    members: members.map((member) => ({
      operationId: member.operationId,
      quoteId: member.quoteId,
      amount: deserializeAmount(member.amount),
    })),
    outputData: parseMintIssuanceAttemptOutputData(JSON.parse(row.outputDataJson)),
    createdAt: row.createdAt,
  };

  if (row.state === 'prepared') {
    return normalizeMintIssuanceAttempt({ ...base, state: 'prepared' });
  }
  if (row.submittedAt === null) {
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

/** Shared SQL persistence for immutable Mint Issuance Attempt recovery records. */
export class SqliteMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: PreparedMintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    if (attempt.state !== 'prepared') {
      throw new Error('Mint issuance attempts must be created in prepared state');
    }

    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO coco_cashu_mint_issuance_attempts
          (id, mintUrl, unit, state, outputDataJson, createdAt, submittedAt, terminalFailureJson)
         VALUES (?, ?, ?, 'prepared', ?, ?, NULL, NULL)`,
        [
          attempt.id,
          attempt.mintUrl,
          attempt.unit,
          JSON.stringify(attempt.outputData),
          attempt.createdAt,
        ],
      );
      for (const [position, member] of attempt.members.entries()) {
        await tx.run(
          `INSERT INTO coco_cashu_mint_issuance_attempt_members
            (attemptId, position, operationId, quoteId, amount)
           VALUES (?, ?, ?, ?, ?)`,
          [
            attempt.id,
            position,
            member.operationId,
            member.quoteId,
            serializeAmount(member.amount),
          ],
        );
      }
    });
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const row = await this.db.get<AttemptRow>(
      'SELECT * FROM coco_cashu_mint_issuance_attempts WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToAttempt(row, await this.getMembers(row.id)) : null;
  }

  async getNewestByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const row = await this.db.get<AttemptRow>(
      `SELECT attempts.* FROM coco_cashu_mint_issuance_attempts attempts
       JOIN coco_cashu_mint_issuance_attempt_members members ON members.attemptId = attempts.id
       WHERE members.operationId = ?
       ORDER BY attempts.createdAt DESC, attempts.id DESC
       LIMIT 1`,
      [operationId],
    );
    return row ? rowToAttempt(row, await this.getMembers(row.id)) : null;
  }

  async listIncomplete(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const params: SqlValue[] = [];
    let where = "state IN ('prepared', 'submitted')";
    if (mintUrl) {
      where += ' AND mintUrl = ?';
      params.push(normalizeMintUrl(mintUrl));
    }
    const rows = await this.db.all<AttemptRow>(
      `SELECT * FROM coco_cashu_mint_issuance_attempts
       WHERE ${where}
       ORDER BY createdAt ASC, id ASC`,
      params,
    );
    return Promise.all(rows.map(async (row) => rowToAttempt(row, await this.getMembers(row.id))));
  }

  async compareAndTransition(
    id: string,
    transition: MintIssuanceAttemptTransition,
  ): Promise<boolean> {
    if (transition.from === 'prepared' && transition.to === 'submitted') {
      if (!Number.isFinite(transition.submittedAt)) {
        throw new Error('Submitted Mint issuance attempt submittedAt must be finite');
      }
      const result = await this.db.run(
        `UPDATE coco_cashu_mint_issuance_attempts
         SET state = 'submitted', submittedAt = ?
         WHERE id = ? AND state = 'prepared'`,
        [transition.submittedAt, id],
      );
      return result.changes === 1;
    }
    if (transition.from === 'submitted' && transition.to === 'succeeded') {
      const result = await this.db.run(
        `UPDATE coco_cashu_mint_issuance_attempts
         SET state = 'succeeded'
         WHERE id = ? AND state = 'submitted'`,
        [id],
      );
      return result.changes === 1;
    }
    if (transition.from === 'submitted' && transition.to === 'failed') {
      const terminalFailure = parseMintIssuanceAttemptFailure(transition.terminalFailure);
      const result = await this.db.run(
        `UPDATE coco_cashu_mint_issuance_attempts
         SET state = 'failed', terminalFailureJson = ?
         WHERE id = ? AND state = 'submitted'`,
        [JSON.stringify(terminalFailure), id],
      );
      return result.changes === 1;
    }
    throw new Error('Illegal Mint issuance attempt transition');
  }

  private async getMembers(attemptId: string): Promise<MemberRow[]> {
    return this.db.all<MemberRow>(
      `SELECT operationId, quoteId, amount
       FROM coco_cashu_mint_issuance_attempt_members
       WHERE attemptId = ?
       ORDER BY position ASC`,
      [attemptId],
    );
  }
}
