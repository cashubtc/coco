import type { Proof } from '@cashu/cashu-ts';
import type { ProofRepository, CoreProof } from 'coco-cashu-core';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

type ProofState = 'inflight' | 'ready' | 'spent';

export class SqliteProofRepository implements ProofRepository {
  private readonly db: SqliteDb;

  constructor(db: SqliteDb) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: Proof[]): Promise<void> {
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
        'INSERT INTO coco_cashu_proofs (mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, "ready", ?)';
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
          now,
        ]);
      }
    });
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = await this.db.all<{
      id: string;
      amount: number;
      secret: string;
      C: string;
      dleqJson: string | null;
      witnessJson: string | null;
    }>(
      'SELECT id, amount, secret, C, dleqJson, witnessJson FROM coco_cashu_proofs WHERE mintUrl = ? AND state = "ready"',
      [mintUrl],
    );
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witnessJson ? { witness: JSON.parse(r.witnessJson) } : {}),
      };
      return { ...base, mintUrl } satisfies CoreProof;
    });
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<{
      mintUrl: string;
      id: string;
      amount: number;
      secret: string;
      C: string;
      dleqJson: string | null;
      witnessJson: string | null;
    }>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson FROM coco_cashu_proofs WHERE state = "ready"',
    );
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witnessJson ? { witness: JSON.parse(r.witnessJson) } : {}),
      };
      return { ...base, mintUrl: r.mintUrl } satisfies CoreProof;
    });
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    const rows = await this.db.all<{
      id: string;
      amount: number;
      secret: string;
      C: string;
      dleqJson: string | null;
      witnessJson: string | null;
    }>(
      'SELECT id, amount, secret, C, dleqJson, witnessJson FROM coco_cashu_proofs WHERE mintUrl = ? AND id = ? AND state = "ready"',
      [mintUrl, keysetId],
    );
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witnessJson ? { witness: JSON.parse(r.witnessJson) } : {}),
      };
      return { ...base, mintUrl } satisfies CoreProof;
    });
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
}
