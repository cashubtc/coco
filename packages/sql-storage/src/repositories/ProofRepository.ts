import {
  DEFAULT_UNIT,
  deserializeAmount,
  normalizeUnit,
  serializeAmount,
  type ProofRepository,
  type ProofUnitFilter,
  type CoreProof,
  type ProofState,
} from '@cashu/coco-core/internal';
import type { SqlDatabase, SqlValue } from '../index.ts';
import { getUnixTimeSeconds, sqlParameterLimit } from '../utils.ts';

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
}

const PROOF_COLUMNS =
  'mintUrl, id, unit, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId';

function normalizeProofUnit(proof: CoreProof): string {
  return normalizeUnit((proof as { unit?: string }).unit);
}

function getUnitFilter(filter?: ProofUnitFilter): string[] | undefined {
  const units = [...(filter?.units ?? []), ...(filter?.unit ? [filter.unit] : [])];
  if (units.length === 0) return undefined;
  return Array.from(new Set(units.map((unit) => normalizeUnit(unit))));
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
        'INSERT INTO coco_cashu_proofs (mintUrl, id, unit, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
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
        ]);
      }
    });
  }

  private async queryProofs(
    sql: string,
    fixed: SqlValue[],
    filter?: ProofUnitFilter,
  ): Promise<CoreProof[]> {
    const units = getUnitFilter(filter);
    if (!units?.length) return (await this.db.all<ProofRow>(sql, fixed)).map(rowToProof);
    const batchSize = sqlParameterLimit(this.db) - fixed.length;
    const proofs: CoreProof[] = [];
    for (let i = 0; i < units.length; i += batchSize) {
      const batch = units.slice(i, i + batchSize);
      const rows = await this.db.all<ProofRow>(
        `${sql} AND unit IN (${batch.map(() => '?').join(', ')})`,
        [...fixed, ...batch],
      );
      proofs.push(...rows.map(rowToProof));
    }
    return proofs;
  }

  async getReadyProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    return this.queryProofs(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND state = 'ready'`,
      [mintUrl],
      filter,
    );
  }

  async getInflightProofs(mintUrls?: string[], filter?: ProofUnitFilter): Promise<CoreProof[]> {
    const sql = `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'inflight'`;
    if (!mintUrls?.length) return this.queryProofs(sql, [], filter);
    const unique = [...new Set(mintUrls.map((url) => url.trim()).filter(Boolean))];
    const units = getUnitFilter(filter);
    const batchSize = units?.length
      ? Math.floor(sqlParameterLimit(this.db) / 2)
      : sqlParameterLimit(this.db);
    const proofs: CoreProof[] = [];
    for (let i = 0; i < unique.length; i += batchSize) {
      const batch = unique.slice(i, i + batchSize);
      proofs.push(
        ...(await this.queryProofs(
          `${sql} AND mintUrl IN (${batch.map(() => '?').join(', ')})`,
          batch,
          filter,
        )),
      );
    }
    return proofs;
  }

  async getAllReadyProofs(filter?: ProofUnitFilter): Promise<CoreProof[]> {
    return this.queryProofs(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'ready'`,
      [],
      filter,
    );
  }

  async getProofsByKeysetId(
    mintUrl: string,
    keysetId: string,
    filter?: ProofUnitFilter,
  ): Promise<CoreProof[]> {
    return this.queryProofs(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND id = ? AND state = 'ready'`,
      [mintUrl, keysetId],
      filter,
    );
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

    const batchSize = sqlParameterLimit(this.db) - 1;
    for (let i = 0; i < uniqueSecrets.length; i += batchSize) {
      const secretBatch = uniqueSecrets.slice(i, i + batchSize);
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

  async getAvailableProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]> {
    return this.queryProofs(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE mintUrl = ? AND state = 'ready' AND usedByOperationId IS NULL`,
      [mintUrl],
      filter,
    );
  }

  async getReservedProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      `SELECT ${PROOF_COLUMNS} FROM coco_cashu_proofs WHERE state = 'ready' AND usedByOperationId IS NOT NULL`,
    );
    return rows.map(rowToProof);
  }
}
