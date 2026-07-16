import { Amount } from '@cashu/cashu-ts';
import {
  assertMintIssuanceAttemptRecoveryMaterialUnchanged,
  normalizeMintIssuanceAttempt,
  normalizeMintUrl,
  serializeAmount,
  type MintIssuanceAttempt,
  type MintIssuanceAttemptRepository,
  type MintIssuanceRequestMetadata,
} from '@cashu/coco-core/adapter';
import type { IdbDb, MintIssuanceAttemptRow } from '../lib/db.ts';

function serializeRequest(request: MintIssuanceRequestMetadata): string {
  if (request.kind === 'single') return JSON.stringify(request);
  return JSON.stringify({
    ...request,
    quoteAmounts: request.quoteAmounts.map(serializeAmount),
  });
}

function deserializeRequest(value: string): MintIssuanceRequestMetadata {
  const request = JSON.parse(value) as
    | Extract<MintIssuanceRequestMetadata, { kind: 'single' }>
    | { kind: 'batch'; quoteIds: string[]; quoteAmounts: Array<string | number> };
  if (request.kind === 'single') return request;
  return {
    ...request,
    quoteAmounts: request.quoteAmounts.map((amount) => Amount.from(amount)),
  };
}

function attemptToRow(attempt: MintIssuanceAttempt): MintIssuanceAttemptRow {
  return {
    id: attempt.id,
    mintUrl: attempt.mintUrl,
    method: attempt.method,
    unit: attempt.unit,
    keysetId: attempt.keysetId,
    state: attempt.state,
    memberOperationIds: [...attempt.memberOperationIds],
    quoteIdsJson: JSON.stringify(attempt.quoteIds),
    quoteAmountsJson: JSON.stringify(attempt.quoteAmounts.map(serializeAmount)),
    signingRequirementsJson: JSON.stringify(attempt.signingRequirements),
    outputDataJson: JSON.stringify(attempt.outputData),
    counterStart: attempt.counterStart ?? null,
    counterEnd: attempt.counterEnd ?? null,
    counterRangeKnown: attempt.counterStart !== undefined,
    requestJson: serializeRequest(attempt.request),
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    submittedAt: attempt.submittedAt ?? null,
    recoveryStartedAt: attempt.recoveryStartedAt ?? null,
    recoveredAt: attempt.recoveredAt ?? null,
    terminalErrorJson: attempt.terminalError ? JSON.stringify(attempt.terminalError) : null,
  };
}

function rowToAttempt(row: MintIssuanceAttemptRow): MintIssuanceAttempt {
  return normalizeMintIssuanceAttempt({
    id: row.id,
    mintUrl: row.mintUrl,
    method: row.method,
    unit: row.unit,
    keysetId: row.keysetId,
    state: row.state,
    memberOperationIds: [...row.memberOperationIds],
    quoteIds: JSON.parse(row.quoteIdsJson),
    quoteAmounts: (JSON.parse(row.quoteAmountsJson) as Array<string | number>).map((amount) =>
      Amount.from(amount),
    ),
    signingRequirements: JSON.parse(row.signingRequirementsJson),
    outputData: JSON.parse(row.outputDataJson),
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

/** IndexedDB persistence for exact Mint Issuance Attempt recovery records. */
export class IdbMintIssuanceAttemptRepository implements MintIssuanceAttemptRepository {
  constructor(private readonly db: IdbDb) {}

  async create(input: MintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    await this.db.runTransaction('rw', ['coco_cashu_mint_issuance_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_issuance_attempts');
      if (await table.get(attempt.id)) {
        throw new Error(`Mint issuance attempt already exists: ${attempt.id}`);
      }
      await table.add(attemptToRow(attempt));
    });
  }

  async update(input: MintIssuanceAttempt): Promise<void> {
    const attempt = normalizeMintIssuanceAttempt(input);
    await this.db.runTransaction('rw', ['coco_cashu_mint_issuance_attempts'], async (tx) => {
      const table = tx.table('coco_cashu_mint_issuance_attempts');
      const existingRow = (await table.get(attempt.id)) as MintIssuanceAttemptRow | undefined;
      if (!existingRow) {
        throw new Error(`Mint issuance attempt not found: ${attempt.id}`);
      }
      assertMintIssuanceAttemptRecoveryMaterialUnchanged(rowToAttempt(existingRow), attempt);
      await table.put({
        ...existingRow,
        state: attempt.state,
        updatedAt: attempt.updatedAt,
        submittedAt: attempt.submittedAt ?? null,
        recoveryStartedAt: attempt.recoveryStartedAt ?? null,
        recoveredAt: attempt.recoveredAt ?? null,
        terminalErrorJson: attempt.terminalError ? JSON.stringify(attempt.terminalError) : null,
      } satisfies MintIssuanceAttemptRow);
    });
  }

  async getById(id: string): Promise<MintIssuanceAttempt | null> {
    const row = (await this.db.table('coco_cashu_mint_issuance_attempts').get(id)) as
      | MintIssuanceAttemptRow
      | undefined;
    return row ? rowToAttempt(row) : null;
  }

  async getByMemberOperationId(operationId: string): Promise<MintIssuanceAttempt | null> {
    const rows = (await this.db
      .table('coco_cashu_mint_issuance_attempts')
      .where('memberOperationIds')
      .equals(operationId)
      .toArray()) as MintIssuanceAttemptRow[];
    rows.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return rows[0] ? rowToAttempt(rows[0]) : null;
  }

  async listRecoverable(mintUrl?: string): Promise<MintIssuanceAttempt[]> {
    const normalizedMintUrl = mintUrl ? normalizeMintUrl(mintUrl) : undefined;
    const rows = (await this.db
      .table('coco_cashu_mint_issuance_attempts')
      .where('state')
      .anyOf(['prepared', 'submitting', 'recovering'])
      .toArray()) as MintIssuanceAttemptRow[];
    return rows
      .filter((row) => !normalizedMintUrl || row.mintUrl === normalizedMintUrl)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map(rowToAttempt);
  }
}
