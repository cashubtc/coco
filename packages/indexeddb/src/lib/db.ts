import Dexie from 'dexie';

export interface IdbDbOptions {
  name?: string;
}

export class IdbDb extends Dexie {
  // tables are defined in schema.ts via version stores
  constructor(options: IdbDbOptions = {}) {
    super(options.name ?? 'coco_cashu');
  }
}

export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// Table types, declared to help repositories with typings
export interface MintRow {
  mintUrl: string;
  name: string;
  mintInfo: string; // JSON string
  createdAt: number;
  updatedAt: number;
}

export interface KeysetRow {
  mintUrl: string;
  id: string;
  keypairs: string; // JSON string
  active: number; // 0/1
  feePpk: number;
  updatedAt: number;
}

export interface CounterRow {
  mintUrl: string;
  keysetId: string;
  counter: number;
}

export interface ProofRow {
  mintUrl: string;
  secret: string;
  state: 'inflight' | 'ready';
  proofJson: string;
  createdAt: number;
}

export interface MintQuoteRow {
  mintUrl: string;
  quote: string;
  state: 'UNPAID' | 'PAID' | 'ISSUED';
  request: string;
  amount: number;
  unit: string;
  expiry: number;
  pubkey?: string | null;
}
