import type {
  Repositories,
  MintRepository,
  KeysetRepository,
  KeyRingRepository,
  CounterRepository,
  ProofRepository,
  MintQuoteRepository,
  SendOperationRepository,
  MeltOperationRepository,
  AuthSessionRepository,
  MintOperationRepository,
  PaymentRequestReceiveAttemptRepository,
  PaymentRequestReceiveOperationRepository,
  MintBatchAttemptRepository,
  ReceiveOperationRepository,
  RepositoryTransactionScope,
} from '@cashu/coco-core';
import { ExpoSqliteDb, type ExpoSqliteDbOptions } from './db.ts';
import { ensureSchema, ensureSchemaUpTo, MIGRATIONS, type Migration } from './schema.ts';
import { ExpoMintRepository } from './repositories/MintRepository.ts';
import { ExpoKeysetRepository } from './repositories/KeysetRepository.ts';
import { ExpoKeyRingRepository } from './repositories/KeyRingRepository.ts';
import { ExpoCounterRepository } from './repositories/CounterRepository.ts';
import { ExpoProofRepository } from './repositories/ProofRepository.ts';
import { ExpoMintQuoteRepository } from './repositories/MintQuoteRepository.ts';
import { ExpoHistoryRepository } from './repositories/HistoryRepository.ts';
import { ExpoSendOperationRepository } from './repositories/SendOperationRepository.ts';
import { ExpoMeltOperationRepository } from './repositories/MeltOperationRepository.ts';
import { ExpoAuthSessionRepository } from './repositories/AuthSessionRepository.ts';
import { ExpoMintOperationRepository } from './repositories/MintOperationRepository.ts';
import { ExpoMintBatchAttemptRepository } from './repositories/MintBatchAttemptRepository.ts';
import { ExpoReceiveOperationRepository } from './repositories/ReceiveOperationRepository.ts';
import {
  ExpoPaymentRequestReceiveAttemptRepository,
  ExpoPaymentRequestReceiveOperationRepository,
} from './repositories/PaymentRequestReceiveRepository.ts';

export interface ExpoSqliteRepositoriesOptions extends ExpoSqliteDbOptions {}

export class ExpoSqliteRepositories implements Repositories {
  readonly mintRepository: MintRepository;
  readonly keyRingRepository: KeyRingRepository;
  readonly counterRepository: CounterRepository;
  readonly keysetRepository: KeysetRepository;
  readonly proofRepository: ProofRepository;
  readonly mintQuoteRepository: MintQuoteRepository;
  readonly historyRepository: ExpoHistoryRepository;
  readonly sendOperationRepository: SendOperationRepository;
  readonly meltOperationRepository: MeltOperationRepository;
  readonly authSessionRepository: AuthSessionRepository;
  readonly mintOperationRepository: MintOperationRepository;
  readonly mintBatchAttemptRepository: MintBatchAttemptRepository;
  readonly receiveOperationRepository: ReceiveOperationRepository;
  readonly paymentRequestReceiveOperationRepository: PaymentRequestReceiveOperationRepository;
  readonly paymentRequestReceiveAttemptRepository: PaymentRequestReceiveAttemptRepository;
  readonly db: ExpoSqliteDb;

  constructor(options: ExpoSqliteRepositoriesOptions) {
    this.db = new ExpoSqliteDb(options);
    this.mintRepository = new ExpoMintRepository(this.db);
    this.keyRingRepository = new ExpoKeyRingRepository(this.db);
    this.counterRepository = new ExpoCounterRepository(this.db);
    this.keysetRepository = new ExpoKeysetRepository(this.db);
    this.proofRepository = new ExpoProofRepository(this.db);
    this.mintQuoteRepository = new ExpoMintQuoteRepository(this.db);
    this.historyRepository = new ExpoHistoryRepository(this.db);
    this.sendOperationRepository = new ExpoSendOperationRepository(this.db);
    this.meltOperationRepository = new ExpoMeltOperationRepository(this.db);
    this.authSessionRepository = new ExpoAuthSessionRepository(this.db);
    this.mintOperationRepository = new ExpoMintOperationRepository(this.db);
    this.mintBatchAttemptRepository = new ExpoMintBatchAttemptRepository(this.db);
    this.receiveOperationRepository = new ExpoReceiveOperationRepository(this.db);
    this.paymentRequestReceiveOperationRepository =
      new ExpoPaymentRequestReceiveOperationRepository(this.db);
    this.paymentRequestReceiveAttemptRepository = new ExpoPaymentRequestReceiveAttemptRepository(
      this.db,
    );
  }

  async init(): Promise<void> {
    await ensureSchema(this.db);
  }

  async withTransaction<T>(fn: (repos: RepositoryTransactionScope) => Promise<T>): Promise<T> {
    return this.db.transaction(async (txDb) => {
      const scopedRepositories: RepositoryTransactionScope = {
        mintRepository: new ExpoMintRepository(txDb),
        keyRingRepository: new ExpoKeyRingRepository(txDb),
        counterRepository: new ExpoCounterRepository(txDb),
        keysetRepository: new ExpoKeysetRepository(txDb),
        proofRepository: new ExpoProofRepository(txDb),
        mintQuoteRepository: new ExpoMintQuoteRepository(txDb),
        historyRepository: new ExpoHistoryRepository(txDb),
        sendOperationRepository: new ExpoSendOperationRepository(txDb),
        meltOperationRepository: new ExpoMeltOperationRepository(txDb),
        authSessionRepository: new ExpoAuthSessionRepository(txDb),
        mintOperationRepository: new ExpoMintOperationRepository(txDb),
        mintBatchAttemptRepository: new ExpoMintBatchAttemptRepository(txDb),
        receiveOperationRepository: new ExpoReceiveOperationRepository(txDb),
        paymentRequestReceiveOperationRepository: new ExpoPaymentRequestReceiveOperationRepository(
          txDb,
        ),
        paymentRequestReceiveAttemptRepository: new ExpoPaymentRequestReceiveAttemptRepository(
          txDb,
        ),
      };

      return fn(scopedRepositories);
    });
  }
}

export {
  ExpoSqliteDb,
  ensureSchema,
  ensureSchemaUpTo,
  MIGRATIONS,
  ExpoMintRepository,
  ExpoKeyRingRepository,
  ExpoKeysetRepository,
  ExpoCounterRepository,
  ExpoProofRepository,
  ExpoMintQuoteRepository,
  ExpoHistoryRepository,
  ExpoSendOperationRepository,
  ExpoMeltOperationRepository,
  ExpoAuthSessionRepository,
  ExpoMintOperationRepository,
  ExpoMintBatchAttemptRepository,
  ExpoReceiveOperationRepository,
  ExpoPaymentRequestReceiveOperationRepository,
  ExpoPaymentRequestReceiveAttemptRepository,
};

export type { Migration };
