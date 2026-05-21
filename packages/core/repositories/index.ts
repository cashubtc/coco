import type { AuthSession } from '@core/models/AuthSession';
import type { HistoryEntry } from '@core/models/History';
import type { Keypair } from '@core/models/Keypair';
import type { MeltQuote } from '@core/models/MeltQuote';
import type { MintQuote } from '@core/models/MintQuote';
import type { MeltOperation, MeltOperationState } from '@core/operations/melt/MeltOperation';
import type { MintOperation, MintOperationState } from '@core/operations/mint/MintOperation';
import type {
  ReceiveOperation,
  ReceiveOperationState,
} from '../operations/receive/ReceiveOperation';
import type {
  PaymentRequestReceiveAttempt,
  PaymentRequestReceiveAttemptState,
  PaymentRequestReceiveOperation,
  PaymentRequestReceiveState,
} from '../operations/paymentRequestReceive/PaymentRequestReceiveOperation';
import type { Counter } from '../models/Counter';
import type { Keyset } from '../models/Keyset';
import type { Mint } from '../models/Mint';
import type { SendOperation, SendOperationState } from '../operations/send/SendOperation';
import type { CoreProof, ProofState } from '../types';

export interface ProofUnitFilter {
  unit?: string;
  units?: string[];
}

export interface MintRepository {
  isTrustedMint(mintUrl: string): Promise<boolean>;
  getMintByUrl(mintUrl: string): Promise<Mint>;
  getAllMints(): Promise<Mint[]>;
  getAllTrustedMints(): Promise<Mint[]>;
  addNewMint(mint: Mint): Promise<void>;
  addOrUpdateMint(mint: Mint): Promise<void>;
  updateMint(mint: Mint): Promise<void>;
  setMintTrusted(mintUrl: string, trusted: boolean): Promise<void>;
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
  getReadyProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]>;
  /**
   * Retrieves all proofs marked as inflight. Can be optionally filtered by a list of mint URLs.
   */
  getInflightProofs(mintUrls?: string[], filter?: ProofUnitFilter): Promise<CoreProof[]>;
  getAllReadyProofs(filter?: ProofUnitFilter): Promise<CoreProof[]>;
  setProofState(mintUrl: string, secrets: string[], state: ProofState): Promise<void>;
  deleteProofs(mintUrl: string, secrets: string[]): Promise<void>;
  getProofsByKeysetId(
    mintUrl: string,
    keysetId: string,
    filter?: ProofUnitFilter,
  ): Promise<CoreProof[]>;
  wipeProofsByKeysetId(mintUrl: string, keysetId: string): Promise<void>;

  /**
   * Reserve proofs for an operation by setting usedByOperationId.
   * Only proofs that are 'ready' and not already reserved can be reserved.
   */
  reserveProofs(mintUrl: string, secrets: string[], operationId: string): Promise<void>;

  /**
   * Release proofs from an operation by clearing usedByOperationId.
   */
  releaseProofs(mintUrl: string, secrets: string[]): Promise<void>;

  /**
   * Set the createdByOperationId for proofs.
   */
  setCreatedByOperation(mintUrl: string, secrets: string[], operationId: string): Promise<void>;

  /**
   * Get a single proof by its secret.
   */
  getProofBySecret(mintUrl: string, secret: string): Promise<CoreProof | null>;

  /**
   * Get proofs matching a batch of secrets for a mint.
   */
  getProofsBySecrets(mintUrl: string, secrets: string[]): Promise<CoreProof[]>;

  /**
   * Get proofs associated with a specific operation (as input or output).
   */
  getProofsByOperationId(mintUrl: string, operationId: string): Promise<CoreProof[]>;

  /**
   * Get available (ready and not reserved) proofs for a mint.
   * This filters out proofs that have usedByOperationId set.
   */
  getAvailableProofs(mintUrl: string, filter?: ProofUnitFilter): Promise<CoreProof[]>;

  /**
   * Get all proofs that are reserved (have usedByOperationId set) and are still in ready state.
   * Used for detecting orphaned reservations during recovery.
   */
  getReservedProofs(): Promise<CoreProof[]>;
}

export interface MintQuoteRepository {
  getMintQuote(mintUrl: string, method: string, quoteId: string): Promise<MintQuote | null>;
  upsertMintQuote(quote: MintQuote): Promise<void>;
  setMintQuoteState(
    mintUrl: string,
    method: string,
    quoteId: string,
    state: MintQuote['state'],
    observedAt?: number,
  ): Promise<void>;
  getPendingMintQuotes(method?: string): Promise<MintQuote[]>;
}

export interface MeltQuoteRepository {
  getMeltQuote(mintUrl: string, method: string, quoteId: string): Promise<MeltQuote | null>;
  upsertMeltQuote(quote: MeltQuote): Promise<void>;
  getPendingMeltQuotes(method?: string): Promise<MeltQuote[]>;
}

export interface KeyRingRepository {
  getPersistedKeyPair(publicKey: string): Promise<Keypair | null>;
  setPersistedKeyPair(keyPair: Keypair): Promise<void>;
  deletePersistedKeyPair(publicKey: string): Promise<void>;
  getAllPersistedKeyPairs(): Promise<Keypair[]>;
  getLatestKeyPair(): Promise<Keypair | null>;
  getLastDerivationIndex(): Promise<number>;
}

export interface HistoryProjectionRepository {
  getPaginatedHistoryEntries(limit: number, offset: number): Promise<HistoryEntry[]>;
  getHistoryEntryById(id: string): Promise<HistoryEntry | null>;
}

export type HistoryRepository = HistoryProjectionRepository;

export interface SendOperationRepository {
  /** Create a new send operation */
  create(operation: SendOperation): Promise<void>;

  /** Update an existing send operation */
  update(operation: SendOperation): Promise<void>;

  /** Get a send operation by ID */
  getById(id: string): Promise<SendOperation | null>;

  /** Get all send operations in a specific state */
  getByState(state: SendOperationState): Promise<SendOperation[]>;

  /** Get all in-flight operations (state in ['executing', 'pending', 'rolling_back']) */
  getPending(): Promise<SendOperation[]>;

  /** Get all operations for a specific mint */
  getByMintUrl(mintUrl: string): Promise<SendOperation[]>;

  /** Delete a send operation */
  delete(id: string): Promise<void>;
}

export interface MeltOperationRepository {
  /** Create a new melt operation */
  create(operation: MeltOperation): Promise<void>;

  /** Update an existing melt operation */
  update(operation: MeltOperation): Promise<void>;

  /** Get a melt operation by ID */
  getById(id: string): Promise<MeltOperation | null>;

  /** Get all melt operations in a specific state */
  getByState(state: MeltOperationState): Promise<MeltOperation[]>;

  /** Get all pending operations (state in ['executing', 'pending']) */
  getPending(): Promise<MeltOperation[]>;

  /** Get all operations for a specific mint */
  getByMintUrl(mintUrl: string): Promise<MeltOperation[]>;

  /** Get all operations for a mint/quote pair */
  getByQuoteId(mintUrl: string, quoteId: string): Promise<MeltOperation[]>;

  /** Delete a melt operation */
  delete(id: string): Promise<void>;
}
export interface AuthSessionRepository {
  getSession(mintUrl: string): Promise<AuthSession | null>;

  saveSession(session: AuthSession): Promise<void>;

  deleteSession(mintUrl: string): Promise<void>;

  getAllSessions(): Promise<AuthSession[]>;
}

export interface MintOperationRepository {
  /** Create a new mint operation */
  create(operation: MintOperation): Promise<void>;

  /** Update an existing mint operation */
  update(operation: MintOperation): Promise<void>;

  /** Get a mint operation by ID */
  getById(id: string): Promise<MintOperation | null>;

  /** Get all mint operations in a specific state */
  getByState(state: MintOperationState): Promise<MintOperation[]>;

  /** Get all in-flight operations (state in ['pending', 'executing']) */
  getPending(): Promise<MintOperation[]>;

  /** Get all operations for a specific mint */
  getByMintUrl(mintUrl: string): Promise<MintOperation[]>;

  /** Get all operations for a mint/method/quote tuple */
  getByQuoteId(mintUrl: string, method: string, quoteId: string): Promise<MintOperation[]>;

  /** Delete a mint operation */
  delete(id: string): Promise<void>;
}

export interface ReceiveOperationRepository {
  /** Create a new receive operation */
  create(operation: ReceiveOperation): Promise<void>;

  /** Update an existing receive operation */
  update(operation: ReceiveOperation): Promise<void>;

  /** Get a receive operation by ID */
  getById(id: string): Promise<ReceiveOperation | null>;

  /** Get all receive operations in a specific state */
  getByState(state: ReceiveOperationState): Promise<ReceiveOperation[]>;

  /** Get all pending operations (state in ['executing']) */
  getPending(): Promise<ReceiveOperation[]>;

  /** Get all operations for a specific mint */
  getByMintUrl(mintUrl: string): Promise<ReceiveOperation[]>;

  /** Get a receive operation created for a payment request receive attempt. */
  getByPaymentRequestAttemptId(attemptId: string): Promise<ReceiveOperation | null>;

  /** Delete a receive operation */
  delete(id: string): Promise<void>;
}

export interface PaymentRequestReceiveOperationRepository {
  create(operation: PaymentRequestReceiveOperation): Promise<void>;
  update(operation: PaymentRequestReceiveOperation): Promise<void>;
  getById(id: string): Promise<PaymentRequestReceiveOperation | null>;
  getByState(state: PaymentRequestReceiveState): Promise<PaymentRequestReceiveOperation[]>;
  getActiveByRequestId(requestId: string): Promise<PaymentRequestReceiveOperation[]>;
  list(filter?: { state?: PaymentRequestReceiveState }): Promise<PaymentRequestReceiveOperation[]>;
}

export interface PaymentRequestReceiveAttemptRepository {
  create(attempt: PaymentRequestReceiveAttempt): Promise<void>;
  update(attempt: PaymentRequestReceiveAttempt): Promise<void>;
  getById(id: string): Promise<PaymentRequestReceiveAttempt | null>;
  getByRequestOperationId(requestOperationId: string): Promise<PaymentRequestReceiveAttempt[]>;
  getByReceiveOperationId(receiveOperationId: string): Promise<PaymentRequestReceiveAttempt | null>;
  getByTransportMessageId(transportMessageId: string): Promise<PaymentRequestReceiveAttempt | null>;
  getByPayloadHash(
    requestOperationId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null>;
  getByRequestIdAndPayloadHash(
    requestId: string,
    payloadHash: string,
  ): Promise<PaymentRequestReceiveAttempt | null>;
  getByState(state: PaymentRequestReceiveAttemptState): Promise<PaymentRequestReceiveAttempt[]>;
  delete(id: string): Promise<void>;
}

interface RepositoriesBase {
  mintRepository: MintRepository;
  keyRingRepository: KeyRingRepository;
  counterRepository: CounterRepository;
  keysetRepository: KeysetRepository;
  proofRepository: ProofRepository;
  mintQuoteRepository: MintQuoteRepository;
  meltQuoteRepository: MeltQuoteRepository;
  historyRepository: HistoryProjectionRepository;
  sendOperationRepository: SendOperationRepository;
  meltOperationRepository: MeltOperationRepository;
  authSessionRepository: AuthSessionRepository;
  mintOperationRepository: MintOperationRepository;
  receiveOperationRepository: ReceiveOperationRepository;
  paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
}

export interface Repositories extends RepositoriesBase {
  init(): Promise<void>;
  withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T>;
}

export type RepositoryTransactionScope = RepositoriesBase;

export * from './memory';
