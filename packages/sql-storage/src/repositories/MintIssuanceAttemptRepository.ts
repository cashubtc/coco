import { Amount } from '@cashu/cashu-ts';
import {
  assertMintIssuanceAttemptRecoveryMaterialUnchanged,
  normalizeMintIssuanceAttempt,
  normalizeMintUrl,
  serializeAmount,
  type MintIssuanceAttempt,
  type MintIssuanceAttemptRepository,
  type MintIssuanceAttemptState,
  type MintIssuanceRequestMetadata,
  type MintIssuanceSigningRequirement,
  type SerializedOutputData,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';

interface AttemptRow {
  id: string;
  mintUrl: string;
  method: MintIssuanceAttempt['method'];
  unit: string;
  keysetId: string;
  state: MintIssuanceAttemptState;
  quoteIdsJson: string;
  quoteAmountsJson: string;
  signingRequirementsJson: string;
  outputDataJson: string;
  counterStart: number | null;
  counterEnd: number | null;
  counterRangeKnown: number;
  requestJson: string;
  createdAt: number;
  updatedAt: number;
  submittedAt: number | null;
  recoveryStartedAt: number | null;
  recoveredAt: number | null;
  terminalErrorJson: string | null;
}

function serializeRequest(request: MintIssuanceRequestMetadata): string {
  return JSON.stringify(request);
}

function deserializeRequest(value: string): MintIssuanceRequestMetadata {
  return JSON.parse(value) as MintIssuanceRequestMetadata;
}

function attemptParams(attempt: MintIssuanceAttempt): SqlValue[] {
  return [
    attempt.id,
    attempt.mintUrl,
    attempt.method,
    attempt.unit,
    attempt.keysetId,
    attempt.state,
    JSON.stringify(attempt.quoteIds),
    JSON.stringify(attempt.quoteAmounts.map(serializeAmount)),
    JSON.stringify(attempt.signingRequirements),
    JSON.stringify(attempt.outputData),
    attempt.counterStart ?? 0,
    attempt.counterEnd ?? 0,
    attempt.counterStart === undefined ? 0 : 1,
    serializeRequest(attempt.request),
    attempt.createdAt,
    attempt.updatedAt,
    attempt.submittedAt ?? null,
    attempt.recoveryStartedAt ?? null,
    attempt.recoveredAt ?? null,
    attempt.terminalError ? JSON.stringify(attempt.terminalError) : null,
  ];
}

function rowToAttempt(row: AttemptRow, memberOperationIds: string[]): MintIssuanceAttempt {
  return normalizeMintIssuanceAttempt({
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method,
    unit: row.unit,
    keysetId: row.keysetId,
    state: row.state,
    memberOperationIds,
    quoteIds: JSON.parse(row.quoteIdsJson) as string[],
    quoteAmounts: (JSON.parse(row.quoteAmountsJson) as Array<string | number>).map((amount) =>
      Amount.from(amount),
    ),
    signingRequirements: JSON.parse(
      row.signingRequirementsJson,
    ) as Array<MintIssuanceSigningRequirement | null>,
    outputData: JSON.parse(row.outputDataJson) as SerializedOutputData,
    counterStart: row.counterRangeKnown ? (row.counterStart ?? undefined) : undefined,
    counterEnd: row.counterRangeKnown ? (row.counterEnd ?? undefined) : undefined,
    request: deserializeRequest(row.requestJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    submittedAt: row.submittedAt ?? undefined,
    recoveryStartedAt: row.recoveryStartedAt ?? undefined,
    recoveredAt: row.recoveredAt ?? undefined,
    terminalError: row.terminalErrorJson ? JSON.parse(row.terminalErrorJson) : undefined,
  });
}

/** Shared SQL persistence for exact Mint Issuance Attempt recovery records. */
export class SqliteMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: MintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    await this.db.transaction(async (tx) => {
      await tx.run(
        `INSERT INTO coco_cashu_mint_issuance_attempts (
          id, mintUrl, method, unit, keysetId, state, quoteIdsJson, quoteAmountsJson,
          signingRequirementsJson, outputDataJson, counterStart, counterEnd, counterRangeKnown,
          requestJson,
          createdAt, updatedAt, submittedAt, recoveryStartedAt, recoveredAt, terminalErrorJson
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attemptParams(attempt),
      );
      await this.replaceMembers(tx, attempt);
    });
  }

  async update(input: MintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    await this.db.transaction(async (tx) => {
      const existingRow = await tx.get<AttemptRow>(
        'SELECT * FROM coco_cashu_mint_issuance_attempts WHERE id = ? LIMIT 1',
        [attempt.id],
      );
      if (!existingRow) throw new Error(`Mint issuance attempt not found: ${attempt.id}`);
      const existing = rowToAttempt(existingRow, await this.getMembers(existingRow.id, tx));
      assertMintIssuanceAttemptRecoveryMaterialUnchanged(existing, attempt);
      await tx.run(
        `UPDATE coco_cashu_mint_issuance_attempts SET
          state = ?, updatedAt = ?, submittedAt = ?, recoveryStartedAt = ?, recoveredAt = ?,
          terminalErrorJson = ?
        WHERE id = ?`,
        [
          attempt.state,
          attempt.updatedAt,
          attempt.submittedAt ?? null,
          attempt.recoveryStartedAt ?? null,
          attempt.recoveredAt ?? null,
          attempt.terminalError ? JSON.stringify(attempt.terminalError) : null,
          attempt.id,
        ],
      );
    });
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const row = await this.db.get<AttemptRow>(
      'SELECT * FROM coco_cashu_mint_issuance_attempts WHERE id = ? LIMIT 1',
      [id],
    );
    return row ? rowToAttempt(row, await this.getMembers(row.id, this.db)) : null;
  }

  async getByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const row = await this.db.get<AttemptRow>(
      `SELECT attempts.* FROM coco_cashu_mint_issuance_attempts attempts
       JOIN coco_cashu_mint_issuance_attempt_members members ON members.attemptId = attempts.id
       WHERE members.operationId = ?
       ORDER BY attempts.createdAt DESC, attempts.id DESC
       LIMIT 1`,
      [operationId],
    );
    return row ? rowToAttempt(row, await this.getMembers(row.id, this.db)) : null;
  }

  async listRecoverable(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const params: SqlValue[] = [];
    let where = "state IN ('prepared', 'submitting', 'recovering')";
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
    return Promise.all(
      rows.map(async (row) => rowToAttempt(row, await this.getMembers(row.id, this.db))),
    );
  }

  private async getMembers(attemptId: string, db: SqlDatabase): Promise<string[]> {
    const rows = await db.all<{ operationId: string }>(
      `SELECT operationId FROM coco_cashu_mint_issuance_attempt_members
       WHERE attemptId = ? ORDER BY position ASC`,
      [attemptId],
    );
    return rows.map((row) => row.operationId);
  }

  private async replaceMembers(db: SqlDatabase, attempt: MintIssuanceAttempt): Promise<void> {
    await db.run('DELETE FROM coco_cashu_mint_issuance_attempt_members WHERE attemptId = ?', [
      attempt.id,
    ]);
    for (const [position, operationId] of attempt.memberOperationIds.entries()) {
      await db.run(
        `INSERT INTO coco_cashu_mint_issuance_attempt_members
          (attemptId, operationId, position) VALUES (?, ?, ?)`,
        [attempt.id, operationId, position],
      );
    }
  }
}
