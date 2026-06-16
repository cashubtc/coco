export type SqlValue = string | number | bigint | Uint8Array | null;

export type SqlParams = readonly SqlValue[];

export interface SqlRunResult {
  readonly lastInsertRowId: number;
  readonly changes: number;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlParams): Promise<SqlRunResult>;
  get<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row | undefined>;
  all<Row extends object = Record<string, unknown>>(
    sql: string,
    params?: SqlParams,
  ): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;
}

export {
  SqlStorageRepositories,
  SqliteMintRepository,
  SqliteKeyRingRepository,
  SqliteKeysetRepository,
  SqliteCounterRepository,
  SqliteProofRepository,
  SqliteMeltQuoteRepository,
  SqliteMintQuoteRepository,
  SqliteLegacyMintQuoteRepository,
  SqliteHistoryRepository,
  SqliteSendOperationRepository,
  SqliteMeltOperationRepository,
  SqliteAuthSessionRepository,
  SqliteMintOperationRepository,
  SqliteReceiveOperationRepository,
  SqlitePaymentRequestReceiveOperationRepository,
  SqlitePaymentRequestReceiveAttemptRepository,
} from './repositories.ts';
export type { SqlStorageRepositoriesOptions } from './repositories.ts';
export { ensureSchema, ensureSchemaUpTo, MIGRATIONS } from './schema.ts';
export type { Migration } from './schema.ts';
