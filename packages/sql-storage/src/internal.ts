/** INTERNAL: no compatibility or versioning guarantees, including patch/minor releases. */

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
  SqliteMintSwapOperationRepository,
} from './repositories.ts';
export type { SqlStorageRepositoriesOptions } from './repositories.ts';
export { ensureSchema, ensureSchemaUpTo, MIGRATIONS } from './schema.ts';
export type { Migration } from './schema.ts';

export { version as storageIntegrationVersion } from '../package.json';
export { SqliteDriverErrors } from './SqliteDriverErrors.ts';
