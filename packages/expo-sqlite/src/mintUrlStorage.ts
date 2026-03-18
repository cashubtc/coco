import { normalizeMintUrl } from 'coco-cashu-core';
import type { ExpoSqliteDb } from './db.ts';

const MINT_URL_STORAGE_TABLES = [
  'coco_cashu_counters',
  'coco_cashu_proofs',
  'coco_cashu_mint_quotes',
  'coco_cashu_melt_quotes',
  'coco_cashu_send_operations',
  'coco_cashu_melt_operations',
] as const;

type MintUrlStorageTable = (typeof MINT_URL_STORAGE_TABLES)[number];

type MintUrlRepairSkipReason =
  | 'normalized_mint_missing'
  | 'proof_conflict'
  | 'mint_quote_conflict'
  | 'melt_quote_conflict'
  | 'melt_operation_conflict';

interface MintUrlStorageIssue {
  table: MintUrlStorageTable;
  mintUrl: string;
  normalizedMintUrl: string;
  rowCount: number;
  repairable: boolean;
  reason?: MintUrlRepairSkipReason;
}

interface MintUrlStorageCheckReport {
  issues: MintUrlStorageIssue[];
  issueCount: number;
  affectedRowCount: number;
  repairableIssueCount: number;
  repairableRowCount: number;
}

interface MintUrlRepairOptions {
  dryRun?: boolean;
}

interface MintUrlRepairAction {
  table: MintUrlStorageTable;
  mintUrl: string;
  normalizedMintUrl: string;
  examinedRows: number;
  updatedRows: number;
  deletedRows: number;
  skippedRows: number;
  conflictRows: number;
  reasons: MintUrlRepairSkipReason[];
}

interface MintUrlRepairReport extends MintUrlStorageCheckReport {
  dryRun: boolean;
  actions: MintUrlRepairAction[];
  updatedRows: number;
  deletedRows: number;
  skippedRows: number;
  conflictRows: number;
}

interface MintUrlCountRow {
  mintUrl: string;
  rowCount: number;
}

interface CounterRow {
  mintUrl: string;
  keysetId: string;
  counter: number;
}

interface ProofRow {
  mintUrl: string;
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleqJson: string | null;
  witnessJson: string | null;
  state: string;
  createdAt: number;
  usedByOperationId: string | null;
  createdByOperationId: string | null;
}

interface MintQuoteRow {
  mintUrl: string;
  quote: string;
  state: string;
  request: string;
  amount: number;
  unit: string;
  expiry: number;
  pubkey: string | null;
}

interface MeltQuoteRow {
  mintUrl: string;
  quote: string;
  state: string;
  request: string;
  amount: number;
  unit: string;
  expiry: number;
  fee_reserve: number;
  payment_preimage: string | null;
}

interface SendOperationRow {
  id: string;
  mintUrl: string;
}

interface MeltOperationRow {
  id: string;
  mintUrl: string;
  quoteId: string | null;
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

async function getCanonicalMintUrls(db: ExpoSqliteDb): Promise<Set<string>> {
  const rows = await db.all<{ mintUrl: string }>('SELECT mintUrl FROM coco_cashu_mints');
  return new Set(rows.map((row) => row.mintUrl));
}

async function collectIssues(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
): Promise<MintUrlStorageIssue[]> {
  const issues: MintUrlStorageIssue[] = [];

  for (const table of MINT_URL_STORAGE_TABLES) {
    const rows = await db.all<MintUrlCountRow>(
      `SELECT mintUrl, COUNT(*) as rowCount FROM ${table} GROUP BY mintUrl`,
    );

    for (const row of rows) {
      const normalizedMintUrl = normalizeMintUrl(row.mintUrl);
      if (normalizedMintUrl === row.mintUrl) {
        continue;
      }

      const reason = getIssueReason(canonicalMintUrls.has(normalizedMintUrl));
      issues.push({
        table,
        mintUrl: row.mintUrl,
        normalizedMintUrl,
        rowCount: row.rowCount,
        repairable: reason === undefined,
        reason,
      });
    }
  }

  return issues;
}

function getAction(
  actions: Map<string, MintUrlRepairAction>,
  table: MintUrlStorageTable,
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

function nullableStringEquals(a: string | null, b: string | null): boolean {
  return a === b;
}

function proofRowsMatch(a: ProofRow, b: ProofRow): boolean {
  return (
    a.id === b.id &&
    a.amount === b.amount &&
    a.secret === b.secret &&
    a.C === b.C &&
    a.dleqJson === b.dleqJson &&
    a.witnessJson === b.witnessJson &&
    a.state === b.state &&
    a.usedByOperationId === b.usedByOperationId &&
    a.createdByOperationId === b.createdByOperationId
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
    nullableStringEquals(a.pubkey, b.pubkey)
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
    nullableStringEquals(a.payment_preimage, b.payment_preimage)
  );
}

async function repairCounters(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<CounterRow>('SELECT mintUrl, keysetId, counter FROM coco_cashu_counters');

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

    const existing = await db.get<CounterRow>(
      'SELECT mintUrl, keysetId, counter FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?',
      [normalizedMintUrl, row.keysetId],
    );

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await db.run('UPDATE coco_cashu_counters SET mintUrl = ? WHERE mintUrl = ? AND keysetId = ?', [
          normalizedMintUrl,
          row.mintUrl,
          row.keysetId,
        ]);
      }
      continue;
    }

    const mergedCounter = Math.max(existing.counter, row.counter);
    if (mergedCounter !== existing.counter) {
      action.updatedRows += 1;
      if (!dryRun) {
        await db.run(
          'UPDATE coco_cashu_counters SET counter = ? WHERE mintUrl = ? AND keysetId = ?',
          [mergedCounter, normalizedMintUrl, row.keysetId],
        );
      }
    }

    action.deletedRows += 1;
    if (!dryRun) {
      await db.run('DELETE FROM coco_cashu_counters WHERE mintUrl = ? AND keysetId = ?', [
        row.mintUrl,
        row.keysetId,
      ]);
    }
  }
}

async function repairProofs(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<ProofRow>(
    'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId FROM coco_cashu_proofs',
  );

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

    const existing = await db.get<ProofRow>(
      'SELECT mintUrl, id, amount, secret, C, dleqJson, witnessJson, state, createdAt, usedByOperationId, createdByOperationId FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?',
      [normalizedMintUrl, row.secret],
    );

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await db.run('UPDATE coco_cashu_proofs SET mintUrl = ? WHERE mintUrl = ? AND secret = ?', [
          normalizedMintUrl,
          row.mintUrl,
          row.secret,
        ]);
      }
      continue;
    }

    if (proofRowsMatch(existing, row)) {
      if (row.createdAt < existing.createdAt) {
        action.updatedRows += 1;
        if (!dryRun) {
          await db.run(
            'UPDATE coco_cashu_proofs SET createdAt = ? WHERE mintUrl = ? AND secret = ?',
            [row.createdAt, normalizedMintUrl, row.secret],
          );
        }
      }

      action.deletedRows += 1;
      if (!dryRun) {
        await db.run('DELETE FROM coco_cashu_proofs WHERE mintUrl = ? AND secret = ?', [
          row.mintUrl,
          row.secret,
        ]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'proof_conflict');
  }
}

async function repairMintQuotes(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<MintQuoteRow>(
    'SELECT mintUrl, quote, state, request, amount, unit, expiry, pubkey FROM coco_cashu_mint_quotes',
  );

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

    const existing = await db.get<MintQuoteRow>(
      'SELECT mintUrl, quote, state, request, amount, unit, expiry, pubkey FROM coco_cashu_mint_quotes WHERE mintUrl = ? AND quote = ?',
      [normalizedMintUrl, row.quote],
    );

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await db.run('UPDATE coco_cashu_mint_quotes SET mintUrl = ? WHERE mintUrl = ? AND quote = ?', [
          normalizedMintUrl,
          row.mintUrl,
          row.quote,
        ]);
      }
      continue;
    }

    if (mintQuoteRowsMatch(existing, row)) {
      action.deletedRows += 1;
      if (!dryRun) {
        await db.run('DELETE FROM coco_cashu_mint_quotes WHERE mintUrl = ? AND quote = ?', [
          row.mintUrl,
          row.quote,
        ]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'mint_quote_conflict');
  }
}

async function repairMeltQuotes(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<MeltQuoteRow>(
    'SELECT mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage FROM coco_cashu_melt_quotes',
  );

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

    const existing = await db.get<MeltQuoteRow>(
      'SELECT mintUrl, quote, state, request, amount, unit, expiry, fee_reserve, payment_preimage FROM coco_cashu_melt_quotes WHERE mintUrl = ? AND quote = ?',
      [normalizedMintUrl, row.quote],
    );

    if (!existing) {
      action.updatedRows += 1;
      if (!dryRun) {
        await db.run('UPDATE coco_cashu_melt_quotes SET mintUrl = ? WHERE mintUrl = ? AND quote = ?', [
          normalizedMintUrl,
          row.mintUrl,
          row.quote,
        ]);
      }
      continue;
    }

    if (meltQuoteRowsMatch(existing, row)) {
      action.deletedRows += 1;
      if (!dryRun) {
        await db.run('DELETE FROM coco_cashu_melt_quotes WHERE mintUrl = ? AND quote = ?', [
          row.mintUrl,
          row.quote,
        ]);
      }
      continue;
    }

    action.skippedRows += 1;
    action.conflictRows += 1;
    addReason(action, 'melt_quote_conflict');
  }
}

async function repairSendOperations(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<SendOperationRow>('SELECT id, mintUrl FROM coco_cashu_send_operations');

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
      await db.run('UPDATE coco_cashu_send_operations SET mintUrl = ? WHERE id = ?', [
        normalizedMintUrl,
        row.id,
      ]);
    }
  }
}

async function repairMeltOperations(
  db: ExpoSqliteDb,
  canonicalMintUrls: Set<string>,
  actions: Map<string, MintUrlRepairAction>,
  dryRun: boolean,
): Promise<void> {
  const rows = await db.all<MeltOperationRow>(
    'SELECT id, mintUrl, quoteId FROM coco_cashu_melt_operations',
  );

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
      const existing = await db.get<MeltOperationRow>(
        'SELECT id, mintUrl, quoteId FROM coco_cashu_melt_operations WHERE mintUrl = ? AND quoteId = ?',
        [normalizedMintUrl, row.quoteId],
      );

      if (existing && existing.id !== row.id) {
        action.skippedRows += 1;
        action.conflictRows += 1;
        addReason(action, 'melt_operation_conflict');
        continue;
      }
    }

    action.updatedRows += 1;
    if (!dryRun) {
      await db.run('UPDATE coco_cashu_melt_operations SET mintUrl = ? WHERE id = ?', [
        normalizedMintUrl,
        row.id,
      ]);
    }
  }
}

export async function detectExpoSqliteMintUrlStorageIssues(
  db: ExpoSqliteDb,
): Promise<MintUrlStorageCheckReport> {
  return db.transaction(async (tx) => {
    const canonicalMintUrls = await getCanonicalMintUrls(tx);
    return createCheckReport(await collectIssues(tx, canonicalMintUrls));
  });
}

export async function repairExpoSqliteMintUrlStorageIssues(
  db: ExpoSqliteDb,
  options: MintUrlRepairOptions = {},
): Promise<MintUrlRepairReport> {
  const dryRun = options.dryRun ?? true;

  return db.transaction(async (tx) => {
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
  });
}
