import {
  DEFAULT_UNIT,
  deserializeAmount,
  normalizeUnit,
  serializeAmount,
  type ProofRepository,
  type ProofUnitFilter,
  type CoreProof,
  type ProofState,
} from '@cashu/coco-core/adapter';
import type { SqlDatabase, SqlValue } from '../index.ts';
import { getUnixTimeSeconds } from '../utils.ts';

interface ProofRow {
  mintUrl: string;
  id: string;
  unit: string | null;
  amount: string | number;
  secret: string;
  C: string;
  dleqJson: string | null;
  witnessJson: string | null;
  state: ProofState;
  usedByOperationId: string | null;
  createdByOperationId: string | null;
  createdByAttemptId: string | null;
}

const MAX_PROOF_SECRET_LOOKUP_BATCH_SIZE = 900;

const PROOF_COLUMNS =
  'mintUrl, id, unit, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId, createdByAttemptId';

function normalizeProofUnit(proof: CoreProof): string {
  return normalizeUnit((proof as { unit?: string }).unit);
}

function getUnitFilter(filter?: ProofUnitFilter): string[] | undefined {
  const units = [...(filter?.units ?? []), ...(filter?.unit ? [filter.unit] : [])];
  if (units.length === 0) return undefined;
  return Array.from(new Set(units.map((unit) => normalizeUnit(unit))));
}

function appendUnitFilter(sql: string, params: SqlValue[], filter?: ProofUnitFilter): string {
  const units = getUnitFilter(filter);
  if (!units || units.length === 0) return sql;
  if (units.length === 1) {
    const [unit] = units as [string];
    params.push(unit);
    return `${sql} AND unit = ?`;
  }
  params.push(...units);
  return `${sql} AND unit IN (${units.map(() => '?').join(', ')})`;
}

function rowToProof(r: ProofRow): CoreProof {
  const base = {
    id: r.id,
    amount: deserializeAmount(r.amount),
    secret: r.secret,
    C: r.C,
    ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
    ...(r.witnessJson ? { witness: JSON.parse(r.witnessJson) } : {}),
  };
  return {
    ...base,
    mintUrl: r.mintUrl,
    unit: normalizeUnit(r.unit ?? undefined, { defaultUnit: DEFAULT_UNIT }),
    state: r.state,
    ...(r.usedByOperationId ? { usedByOperationId: r.usedByOperationId } : {}),
    ...(r.createdByOperationId ? { createdByOperationId: r.createdByOperationId } : {}),
    ...(r.createdByAttemptId ? { createdByAttemptId: r.createdByAttemptId } : {}),
  };
}

export class SqliteProofRepository implements ProofRepository {
  private readonly db: SqlDatabase;

  constructor(db: SqlDatabase) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const now = getUnixTimeSeconds();
    const normalizedProofs = proofs.map((proof) => ({
      ...proof,
      unit: normalizeProofUnit(proof),
    }));
    await this.db.transaction(async (tx) => {
      const selectSql =
        'SELECT 1 AS x FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ? LIMIT 1';
      for (const p of normalizedProofs) {
        const exists = await tx.get<{ x: number }>(selectSql, [mintUrl, p.secret]);
        if (exists) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      const insertSql =
        'INSERT INTO coco_cashu_proofs (mintUrl, id, unit, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId, createdByAttemptId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      for (const p of normalizedProofs) {
        const dleqJson = p.dleq ? JSON.stringify(p.dleq) : null;
        const witnessJson = p.witness ? JSON.stringify(p.witness) : null;
        await tx.run(insertSql, [
          mintUrl,
          p.id,
          p.unit,
          serializeAmount(p.amount),
          p.secret,
          p.C,
          dleqJson,
          witnessJson,
          p.state,
          now,
          p.usedByOperationId ?? null,
          p.createdByOperationId ?? null,
          p.createdByAttemptId ?? null,
        ]);
      }
    });
  }

  async getReadyProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const params: SqlValue[] = [mintUrl];
    const rows = await this.db.all<ProofRow>(
      appendUnitFilter(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND state = 'ready'`,
        params,
        filter,
      ),
      params,
    );
    return rows.map(rowToProof);
  }

  async getInflightProofs(mintUrls?: string[], filter?: ProofUnitFilter): Promise<CoreProof[]> {
    if (!mintUrls || mintUrls.length === 0) {
      const params: SqlValue[] = [];
      const rows = await this.db.all<ProofRow>(
        appendUnitFilter(
          `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'inflight'`,
          params,
          filter,
        ),
        params,
      );
      return rows.map(rowToProof);
    }
    const mintUrlList = mintUrls.map((url) => url.trim()).filter((url) => url.length > 0);
    if (mintUrlList.length === 0) return [];
    const uniqueMintUrls = Array.from(new Set(mintUrlList));
    const placeholders = uniqueMintUrls.map(() => '?').join(', ');
    const params: SqlValue[] = uniqueMintUrls;
    const rows = await this.db.all<ProofRow>(
      appendUnitFilter(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'inflight' AND mintUrl IN (${placeholders})`,
        params,
        filter,
      ),
      params,
    );
    return rows.map(rowToProof);
  }

  async getAllReadyProofs(filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const params: SqlValue[] = [];
    const rows = await this.db.all<ProofRow>(
      appendUnitFilter(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'ready'`,
        params,
        filter,
      ),
      params,
    );
    return rows.map(rowToProof);
  }

  async getProofsByKeysetId(
    mintUrl: string,
    keysetId: string,
    filter?: ProofUnitFilter,
  ): Promise<CoreProof[]> {
    const params: SqlValue[] = [mintUrl, keysetId];
    const rows = await this.db.all<ProofRow>(
      appendUnitFilter(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND id = ? AND state = 'ready'`,
        params,
        filter,
      ),
      params,
    );
    return rows.map(rowToProof);
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.transaction(async (tx) => {
      const updateSql = 'UPDATE coco_cashu_proofs SET state = ? WHERE mintUrl = ? AND secret = ?';
      for (const s of secrets) {
        await tx.run(updateSql, [state, mintUrl, s]);
      }
    });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.transaction(async (tx) => {
      const delSql = 'DELETE FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?';
      for (const s of secrets) {
        await tx.run(delSql, [mintUrl, s]);
      }
    });
  }

  async wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void> {
    await this.db.run('DELETE FROM coco_cashu_proofs WHERE mintUrl = ? AND id = ?;', [
      mintUrl,
      keysetId,
    ]);
  }

  async reserveProofs(mintUrl: string, secrets: string[], operationId: string): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.transaction(async (tx) => {
      // Pre-check: all proofs must exist, be ready, and not already reserved
      const selectSql =
        'SELECT secret, state, usedByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?';
      for (const secret of secrets) {
        const row = await tx.get<{
          secret: string;
          state: string;
          usedByOperationId: string | null;
        }>(selectSql, [mintUrl, secret]);
        if (!row) {
          throw new Error(`Proof with secret not found: ${secret}`);
        }
        if (row.state !== 'ready') {
          throw new Error(`Proof is not ready, cannot reserve: ${secret}`);
        }
        if (row.usedByOperationId) {
          throw new Error(
            `Proof already reserved by operation ${row.usedByOperationId}: ${secret}`,
          );
        }
      }
      // Apply reservation
      const updateSql =
        'UPDATE coco_cashu_proofs SET usedByOperationId = ? WHERE mintUrl = ? AND secret = ?';
      for (const secret of secrets) {
        await tx.run(updateSql, [operationId, mintUrl, secret]);
      }
    });
  }

  async releaseProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.transaction(async (tx) => {
      const updateSql =
        'UPDATE coco_cashu_proofs SET usedByOperationId = NULL WHERE mintUrl = ? AND secret = ?';
      for (const secret of secrets) {
        await tx.run(updateSql, [mintUrl, secret]);
      }
    });
  }

  async setCreatedByOperation(
    mintUrl: string,
    secrets: string[],
    operationId: string,
  ): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.transaction(async (tx) => {
      const updateSql =
        'UPDATE coco_cashu_proofs SET createdByOperationId = ? WHERE mintUrl = ? AND secret = ?';
      for (const secret of secrets) {
        await tx.run(updateSql, [operationId, mintUrl, secret]);
      }
    });
  }

  async getProofBySecret(mintUrl: string, secret: string): Promise<CoreProof | null> {
    const row = await this.db.get<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?`,
      [mintUrl, secret],
    );
    return row ? rowToProof(row) : null;
  }

  async getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]> {
    if (!secrets || secrets.length === 0) {
      return [];
    }

    const uniqueSecrets = Array.from(new Set(secrets));
    const proofsBySecret = new Map<string, CoreProof>();

    for (let i = 0; i < uniqueSecrets.length; i += MAX_PROOF_SECRET_LOOKUP_BATCH_SIZE) {
      const secretBatch = uniqueSecrets.slice(i, i + MAX_PROOF_SECRET_LOOKUP_BATCH_SIZE);
      const placeholders = secretBatch.map(() => '?').join(', ');
      const rows = await this.db.all<ProofRow>(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND secret IN (${placeholders})`,
        [mintUrl, ...secretBatch],
      );

      for (const row of rows) {
        proofsBySecret.set(row.secret, rowToProof(row));
      }
    }

    return uniqueSecrets.flatMap((secret) => {
      const proof = proofsBySecret.get(secret);
      return proof ? [proof] : [];
    });
  }

  async getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND (usedByOperationId = ? OR createdByOperationId = ?)`,
      [mintUrl, operationId, operationId],
    );
    return rows.map(rowToProof);
  }

  async getProofsByAttemptId(mintUrl: string, attemptId: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs
       WHERE mintUrl = ? AND createdByAttemptId = ?`,
      [mintUrl, attemptId],
    );
    return rows.map(rowToProof);
  }

  async getAvailableProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const params: SqlValue[] = [mintUrl];
    const rows = await this.db.all<ProofRow>(
      appendUnitFilter(
        `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND state = 'ready' AND usedByOperationId IS NULL`,
        params,
        filter,
      ),
      params,
    );
    return rows.map(rowToProof);
  }

  async getReservedProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'ready' AND usedByOperationId IS NOT NULL`,
    );
    return rows.map(rowToProof);
  }
}
