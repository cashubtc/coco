import type { Mint } from '../models/Mint';
import type { Keyset } from '../models/Keyset';
import type { Counter } from '../models/Counter';
import type { CoreProof, ProofState } from '../types';
import type { MintQuote } from '@core/models/MintQuote';
import type { MeltQuote } from '@core/models/MeltQuote';

export interface MintRepository {
  isKnownMint(mintUrl: string): Promise<boolean>;
  getMintByUrl(mintUrl: string): Promise<Mint>;
  getAllMints(): Promise<Mint[]>;
  addNewMint(mint: Mint): Promise<void>;
  updateMint(mint: Mint): Promise<void>;
  deleteMint(mintUrl: string): Promise<void>;
}

export interface KeysetRepository {
  getKeysetsByMintUrl(mintUrl: string): Promise<Keyset[]>;
  getKeysetById(mintUrl: string, id: string): Promise<Keyset | null>;
  updateKeyset(keyset: Omit<Keyset, 'keypairs' | 'updatedAt'>): Promise<void>;
  addKeyset(keyset: Omit<Keyset, 'updatedAt'>): Promise<void>;
  deleteKeyset(mintUrl: string, keysetId: string): Promise<void>;
}

export interface CounterRepository {
  getCounter(mintUrl: string, keysetId: string): Promise<Counter | null>;
  setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void>;
}

export interface ProofRepository {
  saveProofs(mintUrl: string, proofs: CoreProof[]): Promise<void>;
  getReadyProofs(mintUrl: string): Promise<CoreProof[]>;
  getAllReadyProofs(): Promise<CoreProof[]>;
  setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void>;
  deleteProofs(mintUrl: string, secrets: string[]): Promise<void>;
  getProofsByKeysetId(mintUrl: string, keysetId: string): Promise<CoreProof[]>;
  wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void>;
}

export interface MintQuoteRepository {
  getMintQuote(mintUrl: string, quoteId: string): Promise<MintQuote | null>;
  addMintQuote(quote: MintQuote): Promise<void>;
  setMintQuoteState(mintUrl: string, quoteId: string, state: MintQuote['state']): Promise<void>;
  getPendingMintQuotes(): Promise<MintQuote[]>;
}

export interface MeltQuoteRepository {
  getMeltQuote(mintUrl: string, quoteId: string): Promise<MeltQuote | null>;
  addMeltQuote(quote: MeltQuote): Promise<void>;
  setMeltQuoteState(mintUrl: string, quoteId: string, state: MeltQuote['state']): Promise<void>;
  getPendingMeltQuotes(): Promise<MeltQuote[]>;
}

export interface Repositories {
  mintRepository: MintRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
}

export * from './memory';
