import type { Keypair, KeypairPurpose } from '../models/Keypair.ts';

/** Reads existing keys only; missing keys are never created as a side effect. */
export interface KeypairQueries {
  getPersistedKeyPair(publicKey: string, purpose: KeypairPurpose): Promise<Keypair | null>;
  getLatestKeyPair(purpose: KeypairPurpose): Promise<Keypair | null>;
  getAllPersistedKeyPairs(purpose: KeypairPurpose): Promise<Keypair[]>;
}
