import type { ProofRepository, CoreProof, ProofState } from 'coco-cashu-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

interface ProofRow {
  mintUrl: string;
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleqJson: string | null;
  witnessJson: string | null;
  state: ProofState;
  usedByOperationId: string | null;
  createdByOperationId: string | null;
}

function rowToProof(r: ProofRow): CoreProof {
  const base = {
    id: r.id,
    amount: r.amount,
    secret: r.secret,
    C: r.C,
    ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
    ...(r.witnessJson ? { witness: JSON.parse(r.witnessJson) } : {}),
  };
  return {
    ...base,
    mintUrl: r.mintUrl,
    state: r.state,
    ...(r.usedByOperationId ? { usedByOperationId: r.usedByOperationId } : {}),
    ...(r.createdByOperationId ? { createdByOperationId: r.createdByOperationId } : {}),
  };
}

export class SqliteProofRepository implements ProofRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const now = getUnixTimeSeconds();
    await this.db.transaction(async (tx) => {
      const selectSql =
        'SELECT 1 AS x FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ? LIMIT 1';
      for (const p of proofs) {
        const exists = await tx.get<{ x: number }>(selectSql, [mintUrl, p.secret]);
        if (exists) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      const insertSql =
        'INSERT INTO coco_cashu_proofs (mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
      for (const p of proofs) {
        const dleqJson = p.dleq ? JSON.stringify(p.dleq) : null;
        const witnessJson = p.witness ? JSON.stringify(p.witness) : null;
        await tx.run(insertSql, [
          mintUrl,
          p.id,
          p.amount,
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

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND state = "ready"',
      [mintUrl],
    );
    return rows.map(rowToProof);
  }

  async getInflightProofs(mintUrls: string[]): Promise<CoreProof[]> {
    if (!mintUrls || mintUrls.length === 0) {
      const rows = await this.db.all<ProofRow>(
        'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE state = "inflight"',
      );
      return rows.map(rowToProof);
    }
    const mintUrlList = mintUrls.map((url) => url.trim()).filter((url) => url.length > 0);
    if (mintUrlList.length === 0) return [];
    const uniqueMintUrls = Array.from(new Set(mintUrlList));
    const placeholders = uniqueMintUrls.map(() => '?').join(', ');
    const rows = await this.db.all<ProofRow>(
      `SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE state = "inflight" AND mintUrl IN (${placeholders})`,
      uniqueMintUrls,
    );
    return rows.map(rowToProof);
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE state = "ready"',
    );
    return rows.map(rowToProof);
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND id = ? AND state = "ready"',
      [mintUrl, keysetId],
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
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [mintUrl, secret],
    );
    return row ? rowToProof(row) : null;
  }

  async getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND (usedByOperationId = ? OR createdByOperationId = ?)',
      [mintUrl, operationId, operationId],
    );
    return rows.map(rowToProof);
  }

  async getAvailableProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND state = "ready" AND usedByOperationId IS NULL',
      [mintUrl],
    );
    return rows.map(rowToProof);
  }

  async getReservedProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE state = "ready" AND usedByOperationId IS NOT NULL',
    );
    return rows.map(rowToProof);
  }
}
