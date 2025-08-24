import type { Proof } from '@cashu/cashu-ts';
import type { ProofRepository, CoreProof } from '../core.ts';
import { SqliteDb, getUnixTimeSeconds } from '../db.ts';

type ProofState = 'inflight' | 'ready';

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
        'INSERT INTO coco_cashu_proofs (mintUrl, secret, state, proofJson, createdAt) VALUES (?, ?, "ready", ?, ?)';
      for (const p of proofs) {
        await tx.run(insertSql, [mintUrl, p.secret, JSON.stringify(p), now]);
      }
    });
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = await this.db.all<{ proofJson: string }>(
      'SELECT proofJson FROM coco_cashu_proofs WHERE mintUrl = ? AND state = "ready"',
      [mintUrl],
    );
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl } satisfies CoreProof;
    });
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = await this.db.all<{ proofJson: string; mintUrl: string }>(
      'SELECT proofJson, mintUrl FROM coco_cashu_proofs WHERE state = "ready"',
    );
    return rows.map((r) => {
      const base = JSON.parse(r.proofJson) as Proof;
      return { ...base, mintUrl: r.mintUrl } satisfies CoreProof;
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
