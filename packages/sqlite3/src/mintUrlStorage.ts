import {
  detectSqliteLikeMintUrlStorageIssues,
  repairSqliteLikeMintUrlStorageIssues,
} from '../../shared/src/sqlite/mintUrlStorage.ts';
import { normalizeMintUrl } from 'coco-cashu-core';
import type { SqliteDb } from './db.ts';

export const MINT_URL_STORAGE_TABLES = [
  'coco_cashu_counters',
  'coco_cashu_proofs',
  'coco_cashu_mint_quotes',
  'coco_cashu_melt_quotes',
  'coco_cashu_history',
  'coco_cashu_send_operations',
  'coco_cashu_melt_operations',
] as const;

export const REPAIRABLE_MINT_URL_STORAGE_TABLES = MINT_URL_STORAGE_TABLES;

export type MintUrlStorageTable = (typeof MINT_URL_STORAGE_TABLES)[number];
export type RepairableMintUrlStorageTable = (typeof REPAIRABLE_MINT_URL_STORAGE_TABLES)[number];

export type MintUrlRepairSkipReason =
  | 'normalized_mint_missing'
  | 'proof_conflict'
  | 'mint_quote_conflict'
  | 'melt_quote_conflict'
  | 'history_conflict'
  | 'melt_operation_conflict';

export interface MintUrlStorageIssue {
  table: MintUrlStorageTable;
  mintUrl: string;
  normalizedMintUrl: string;
  rowCount: number;
  repairable: boolean;
  reason?: MintUrlRepairSkipReason;
}

export interface MintUrlStorageCheckReport {
  issues: MintUrlStorageIssue[];
  issueCount: number;
  affectedRowCount: number;
  repairableIssueCount: number;
  repairableRowCount: number;
}

export interface MintUrlRepairOptions {
  dryRun?: boolean;
}

export interface MintUrlRepairAction {
  table: RepairableMintUrlStorageTable;
  mintUrl: string;
  normalizedMintUrl: string;
  examinedRows: number;
  updatedRows: number;
  deletedRows: number;
  skippedRows: number;
  conflictRows: number;
  reasons: MintUrlRepairSkipReason[];
}

export interface MintUrlRepairReport extends MintUrlStorageCheckReport {
  dryRun: boolean;
  actions: MintUrlRepairAction[];
  updatedRows: number;
  deletedRows: number;
  skippedRows: number;
  conflictRows: number;
}

export async function detectSqliteMintUrlStorageIssues(
  db: SqliteDb,
): Promise<MintUrlStorageCheckReport> {
  return detectSqliteLikeMintUrlStorageIssues(db, normalizeMintUrl);
}

export async function repairSqliteMintUrlStorageIssues(
  db: SqliteDb,
  options: MintUrlRepairOptions = {},
): Promise<MintUrlRepairReport> {
  return repairSqliteLikeMintUrlStorageIssues(db, normalizeMintUrl, options);
}
