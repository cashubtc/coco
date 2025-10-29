import type { Proof } from '@cashu/cashu-ts';
import type { ProofRepository, CoreProof, ProofState } from 'coco-cashu-core';
import type { IdbDb, ProofRow } from '../lib/db.ts';

// use ProofState from coco-cashu-core

export class IdbProofRepository implements ProofRepository {
  private readonly db: IdbDb;

  constructor(db: IdbDb) {
    this.db = db;
  }

  async saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void> {
    if (!proofs || proofs.length === 0) return;
    const now = Math.floor(Date.now() / 1000);
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const p of proofs) {
        const existing = await table.get([mintUrl, p.secret]);
        if (existing) {
          throw new Error(`Proof with secret already exists: ${p.secret}`);
        }
      }
      for (const p of proofs) {
        const row: ProofRow = {
          mintUrl,
          id: p.id,
          amount: p.amount,
          secret: p.secret,
          C: p.C,
          dleqJson: p.dleq ? JSON.stringify(p.dleq) : null,
          witness: p.witness ? JSON.stringify(p.witness) : null,
          state: p.state,
          createdAt: now,
        };
        await table.put(row);
      }
    });
  }

  async getReadyProofs(mintUrl: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+state]')
      .equals([mintUrl, 'ready'])
      .toArray()) as ProofRow[];
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witness ? { witness: JSON.parse(r.witness) } : {}),
      };
      return { ...base, mintUrl, state: 'ready' } satisfies CoreProof;
    });
  }

  async getAllReadyProofs(): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('state')
      .equals('ready')
      .toArray()) as ProofRow[];
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witness ? { witness: JSON.parse(r.witness) } : {}),
      };
      return { ...base, mintUrl: r.mintUrl, state: 'ready' } satisfies CoreProof;
    });
  }

  async getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]> {
    const rows = (await (this.db as any)
      .table('coco_cashu_proofs')
      .where('[mintUrl+id+state]')
      .equals([mintUrl, keysetId, 'ready'])
      .toArray()) as ProofRow[];
    return rows.map((r) => {
      const base: Proof = {
        id: r.id,
        amount: r.amount,
        secret: r.secret,
        C: r.C,
        ...(r.dleqJson ? { dleq: JSON.parse(r.dleqJson) } : {}),
        ...(r.witness ? { witness: JSON.parse(r.witness) } : {}),
      };
      return { ...base, mintUrl, state: 'ready' } satisfies CoreProof;
    });
  }

  async setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const s of secrets) {
        const existing = (await table.get([mintUrl, s])) as ProofRow | undefined;
        if (existing) {
          await table.put({ ...existing, state } as ProofRow);
        }
      }
    });
  }

  async deleteProofs(mintUrl: string, secrets: string[]): Promise<void> {
    if (!secrets || secrets.length === 0) return;
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      for (const s of secrets) {
        await table.delete([mintUrl, s]);
      }
    });
  }

  async wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void> {
    await this.db.runTransaction('rw', ['coco_cashu_proofs'], async (tx) => {
      const table = tx.table('coco_cashu_proofs');
      const rows = (await table
        .where('[mintUrl+id]')
        .equals([mintUrl, keysetId])
        .toArray()) as ProofRow[];
      for (const r of rows) {
        await table.delete([mintUrl, r.secret]);
      }
    });
  }
}
