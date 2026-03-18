import type { Transaction as DexieTransaction } from 'dexie';
import { normalizeMintUrl } from 'coco-cashu-core';
import type {
  CounterRow,
  IdbDb,
  MeltOperationRow,
  MeltQuoteRow,
  MintQuoteRow,
  ProofRow,
  SendOperationRow,
} from './lib/db.ts';

export const MINT_URL_STORAGE_TABLES = [
  'coco_cashu_counters',
  'coco_cashu_proofs',
  'coco_cashu_mint_quotes',
  'coco_cashu_melt_quotes',
  'coco_cashu_send_operations',
  'coco_cashu_melt_operations',
] as const;

export const REPAIRABLE_MINT_URL_STORAGE_TABLES = MINT_URL_STORAGE_TABLES;
const TRANSACTION_TABLES = ['coco_cashu_mints', ...MINT_URL_STORAGE_TABLES] as const;

export type MintUrlStorageTable = (typeof MINT_URL_STORAGE_TABLES)[number];
export type RepairableMintUrlStorageTable = (typeof REPAIRABLE_MINT_URL_STORAGE_TABLES)[number];

export type MintUrlRepairSkipReason =
  | 'normalized_mint_missing'
  | 'proof_conflict'
  | 'mint_quote_conflict'
  | 'melt_quote_conflict'
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

interface MintUrlRecord {
  mintUrl: string;
}

interface TableLike<T, TKey = unknown> {
  toArray(): Promise<T[]>;
  get(key: TKey): Promise<T | undefined>;
  put(value: T): Promise<unknown>;
  delete(key: TKey): Promise<void>;
}

function compareIssue(a: MintUrlStorageIssue, b: MintUrlStorageIssue): number {
  return (
    a.table.localeCompare(b.table) ||
    a.mintUrl.localeCompare(b.mintUrl) ||
    a.normalizedMintUrl.localeCompare(b.normalizedMintUrl)
  );
}

function compareAction(a: MintUrlRepairAction, b: MintUrlRepairAction): number {
  return (
    a.table.localeCompare(b.table) ||
    a.mintUrl.localeCompare(b.mintUrl) ||
    a.normalizedMintUrl.localeCompare(b.normalizedMintUrl)
  );
}

function createCheckReport(issues: MintUrlStorageIssue[]): MintUrlStorageCheckReport {
  const sortedIssues = [...issues].sort(compareIssue);
  return {
    issues: sortedIssues,
    issueCount: sortedIssues.length,
    affectedRowCount: sortedIssues.reduce((sum, issue) => sum + issue.rowCount, 0),
    repairableIssueCount: sortedIssues.filter((issue) => issue.repairable).length,
    repairableRowCount: sortedIssues
      .filter((issue) => issue.repairable)
      .reduce((sum, issue) => sum + issue.rowCount, 0),
  };
}

function getIssueReason(normalizedMintExists: boolean): MintUrlRepairSkipReason | undefined {
  if (!normalizedMintExists) {
    return 'normalized_mint_missing';
  }

  return undefined;
}

function getTable<T, TKey = unknown>(tx: DexieTransaction, tableName: string): TableLike<T, TKey> {
  return tx.table(tableName) as unknown as TableLike<T, TKey>;
}

async function getCanonicalMintUrls(tx: DexieTransaction): Promise<Set<string>> {
  const rows = await getTable<MintUrlRecord>(tx, 'coco_cashu_mints').toArray();
  return new Set(rows.map((row) => row.mintUrl));
}

async function collectIssues(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
): Promise<MintUrlStorageIssue[]> {
  const issues: MintUrlStorageIssue[] = [];

  for (const table of MINT_URL_STORAGE_TABLES) {
    const rows = await getTable<MintUrlRecord>(tx, table).toArray();
    const counts = new Map<string, number>();

    for (const row of rows) {
      counts.set(row.mintUrl, (counts.get(row.mintUrl) ?? 0) + 1);
    }

    for (const [mintUrl, rowCount] of counts) {
      const normalizedMintUrl = normalizeMintUrl(mintUrl);
      if (normalizedMintUrl === mintUrl) {
        continue;
      }

      const reason = getIssueReason(canonicalMintUrls.has(normalizedMintUrl));
      issues.push({
        table,
        mintUrl,
        normalizedMintUrl,
        rowCount,
        repairable: reason === undefined,
        reason,
      });
    }
  }

  return issues;
}

function getAction(
  actions: Map<string, MintUrlRepairAction>,
  table: RepairableMintUrlStorageTable,
  mintUrl: string,
  normalizedMintUrl: string,
): MintUrlRepairAction {
  const key = `${table}::${mintUrl}::${normalizedMintUrl}`;
  const existing = actions.get(key);
  if (existing) {
    return existing;
  }

  const action: MintUrlRepairAction = {
    table,
    mintUrl,
    normalizedMintUrl,
    examinedRows: 0,
    updatedRows: 0,
    deletedRows: 0,
    skippedRows: 0,
    conflictRows: 0,
    reasons: [],
  };
  actions.set(key, action);
  return action;
}

function addReason(action: MintUrlRepairAction, reason: MintUrlRepairSkipReason): void {
  if (!action.reasons.includes(reason)) {
    action.reasons.push(reason);
  }
}

function normalizeNullableString(value: string | null | undefined): string | null {
  return value ?? null;
}

function proofRowsMatch(a: ProofRow, b: ProofRow): boolean {
  return (
    a.id === b.id &&
    a.amount === b.amount &&
    a.secret === b.secret &&
    a.C === b.C &&
    normalizeNullableString(a.dleqJson) === normalizeNullableString(b.dleqJson) &&
    normalizeNullableString(a.witness) === normalizeNullableString(b.witness) &&
    a.state === b.state &&
    normalizeNullableString(a.usedByOperationId) === normalizeNullableString(b.usedByOperationId) &&
    normalizeNullableString(a.createdByOperationId) ===
      normalizeNullableString(b.createdByOperationId)
  );
}

function mintQuoteRowsMatch(a: MintQuoteRow, b: MintQuoteRow): boolean {
  return (
    a.quote === b.quote &&
    a.state === b.state &&
    a.request === b.request &&
    a.amount === b.amount &&
    a.unit === b.unit &&
    a.expiry === b.expiry &&
    normalizeNullableString(a.pubkey) === normalizeNullableString(b.pubkey)
  );
}

function meltQuoteRowsMatch(a: MeltQuoteRow, b: MeltQuoteRow): boolean {
  return (
    a.quote === b.quote &&
    a.state === b.state &&
    a.request === b.request &&
    a.amount === b.amount &&
    a.unit === b.unit &&
    a.expiry === b.expiry &&
    a.fee_reserve === b.fee_reserve &&
    normalizeNullableString(a.payment_preimage) === normalizeNullableString(b.payment_preimage)
  );
}

async function repairCounters(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<CounterRow, [string, string]>(tx, 'coco_cashu_counters');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_counters', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    const existing = (await table.get([normalizedMintUrl, row.keysetId])) as CounterRow | undefined;

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.keysetId]);
        await table.put({ ...row, mintUrl: normalizedMintUrl });
      }
      continue;
    }

    const mergedCounter = Math.max(existing.counter, row.counter);
    if (mergedCounter !== existing.counter) {
      action.updatedRows += 1;
      if (!dryRun) {
        await table.put({ ...existing, counter: mergedCounter });
      }
    }

    action.deletedRows += 1;
    if (!dryRun) {
      await table.delete([row.mintUrl, row.keysetId]);
    }
  }
}

async function repairProofs(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<ProofRow, [string, string]>(tx, 'coco_cashu_proofs');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_proofs', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    const existing = (await table.get([normalizedMintUrl, row.secret])) as ProofRow | undefined;

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.secret]);
        await table.put({ ...row, mintUrl: normalizedMintUrl });
      }
      continue;
    }

    if (proofRowsMatch(existing, row)) {
      if (row.createdAt < existing.createdAt) {
        action.updatedRows += 1;
        if (!dryRun) {
          await table.put({ ...existing, createdAt: row.createdAt });
        }
      }

      action.deletedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.secret]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'proof_conflict');
  }
}

async function repairMintQuotes(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<MintQuoteRow, [string, string]>(tx, 'coco_cashu_mint_quotes');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_mint_quotes', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    const existing = (await table.get([normalizedMintUrl, row.quote])) as MintQuoteRow | undefined;

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.quote]);
        await table.put({ ...row, mintUrl: normalizedMintUrl });
      }
      continue;
    }

    if (mintQuoteRowsMatch(existing, row)) {
      action.deletedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.quote]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'mint_quote_conflict');
  }
}

async function repairMeltQuotes(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<MeltQuoteRow, [string, string]>(tx, 'coco_cashu_melt_quotes');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_melt_quotes', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    const existing = (await table.get([normalizedMintUrl, row.quote])) as MeltQuoteRow | undefined;

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.quote]);
        await table.put({ ...row, mintUrl: normalizedMintUrl });
      }
      continue;
    }

    if (meltQuoteRowsMatch(existing, row)) {
      action.deletedRows += 1;
      if (!dryRun) {
        await table.delete([row.mintUrl, row.quote]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'melt_quote_conflict');
  }
}

async function repairSendOperations(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<SendOperationRow, string>(tx, 'coco_cashu_send_operations');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_send_operations', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    action.updatedRows += 1;
    if (!dryRun) {
      await table.put({ ...row, mintUrl: normalizedMintUrl });
    }
  }
}

async function repairMeltOperations(
  tx: DexieTransaction,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const table = getTable<MeltOperationRow, string>(tx, 'coco_cashu_melt_operations');
  const rows = await table.toArray();

  for (const row of rows) {
    const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
    if (normalizedMintUrl === row.mintUrl) {
      continue;
    }

    const action = getAction(actions, 'coco_cashu_melt_operations', row.mintUrl, normalizedMintUrl);
    action.examinedRows += 1;

    if (!canonicalMintUrls.has(normalizedMintUrl)) {
      action.skippedRows += 1;
      addReason(action, 'normalized_mint_missing');
      continue;
    }

    if (row.quoteId) {
      const existingRows = await table.toArray();
      const existing = existingRows.find(
        (candidate) =>
          candidate.mintUrl === normalizedMintUrl &&
          candidate.quoteId === row.quoteId &&
          candidate.id !== row.id,
      );

      if (existing) {
        action.skippedRows += 1;
        action.conflictRows += 1;
        addReason(action, 'melt_operation_conflict');
        continue;
      }
    }

    action.updatedRows += 1;
    if (!dryRun) {
      await table.put({ ...row, mintUrl: normalizedMintUrl });
    }
  }
}

export async function detectIndexedDbMintUrlStorageIssuesInTransaction(
  tx: DexieTransaction,
): Promise<MintUrlStorageCheckReport> {
  const canonicalMintUrls = await getCanonicalMintUrls(tx);
  return createCheckReport(await collectIssues(tx, canonicalMintUrls));
}

export async function detectIndexedDbMintUrlStorageIssues(
  db: IdbDb,
): Promise<MintUrlStorageCheckReport> {
  return db.runTransaction('r', [...TRANSACTION_TABLES], async (tx) =>
    detectIndexedDbMintUrlStorageIssuesInTransaction(tx),
  );
}

export async function repairIndexedDbMintUrlStorageIssuesInTransaction(
  tx: DexieTransaction,
  options: MintUrlRepairOptions = {},
): Promise<MintUrlRepairReport> {
  const dryRun = options.dryRun ?? true;
  const canonicalMintUrls = await getCanonicalMintUrls(tx);
  const issues = await collectIssues(tx, canonicalMintUrls);
  const actions = new Map<string, MintUrlRepairAction>();

  await repairCounters(tx, canonicalMintUrls, actions, dryRun);
  await repairProofs(tx, canonicalMintUrls, actions, dryRun);
  await repairMintQuotes(tx, canonicalMintUrls, actions, dryRun);
  await repairMeltQuotes(tx, canonicalMintUrls, actions, dryRun);
  await repairSendOperations(tx, canonicalMintUrls, actions, dryRun);
  await repairMeltOperations(tx, canonicalMintUrls, actions, dryRun);

  const actionList = Array.from(actions.values()).sort(compareAction);
  const report = createCheckReport(issues);

  return {
    ...report,
    dryRun,
    actions: actionList,
    updatedRows: actionList.reduce((sum, action) => sum + action.updatedRows, 0),
    deletedRows: actionList.reduce((sum, action) => sum + action.deletedRows, 0),
    skippedRows: actionList.reduce((sum, action) => sum + action.skippedRows, 0),
    conflictRows: actionList.reduce((sum, action) => sum + action.conflictRows, 0),
  };
}

export async function repairIndexedDbMintUrlStorageIssues(
  db: IdbDb,
  options: MintUrlRepairOptions = {},
): Promise<MintUrlRepairReport> {
  return db.runTransaction('rw', [...TRANSACTION_TABLES], async (tx) => {
    return repairIndexedDbMintUrlStorageIssuesInTransaction(tx, options);
  });
}
