import type { Mint } from "../models/Mint";
import type { Keyset } from "../models/Keyset";
import type { Counter } from "../models/Counter";
import type { Proof } from "@cashu/cashu-ts";
import type { CoreProof } from "../types";

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
  updateKeyset(keyset: Omit<Keyset, "keypairs" | "updatedAt">): Promise<void>;
  addKeyset(keyset: Omit<Keyset, "updatedAt">): Promise<void>;
  deleteKeyset(mintUrl: string, keysetId: string): Promise<void>;
}

export interface CounterRepository {
  getCounter(mintUrl: string, keysetId: string): Promise<Counter | null>;
  setCounter(mintUrl: string, keysetId: string, counter: number): Promise<void>;
}

export interface ProofRepository {
  saveProofs(mintUrl: string, proofs: Proof[]): Promise<void>;
  getReadyProofs(mintUrl: string): Promise<CoreProof[]>;
  getAllReadyProofs(): Promise<CoreProof[]>;
  setProofState(
    mintUrl: string,
    secrets: string[],
    state: "inflight" | "ready"
  ): Promise<void>;
  deleteProofs(mintUrl: string, secrets: string[]): Promise<void>;
}

export * from "./memory";
