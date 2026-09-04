#!/usr/bin/env bun

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

export type TransactionArchitectureRule =
  | 'application-gateway-application-gateway'
  | 'application-gateway-repository'
  | 'operation-service-repository'
  | 'operation-service-runner'
  | 'transaction-scope-application-gateway'
  | 'transaction-scope-live-event-bus'
  | 'transaction-scope-remote-infrastructure'
  | 'transaction-scope-runner'
  | 'transaction-scope-service';

export interface SourceModule {
  path: string;
  sourceText: string;
}

export interface TransactionArchitectureViolation {
  rule: TransactionArchitectureRule;
  importer: string;
  importSource: string;
  importedNames: string[];
  reason: string;
}

export interface AllowlistedTransactionImport {
  rule: TransactionArchitectureRule;
  importer: string;
  importSource: string;
  importedNames: string[];
  reason: string;
}

export interface TransactionArchitectureResult {
  violations: TransactionArchitectureViolation[];
  allowedViolations: TransactionArchitectureViolation[];
  unexpectedViolations: TransactionArchitectureViolation[];
  staleAllowlist: AllowlistedTransactionImport[];
}

interface ImportEdge {
  importer: string;
  importSource: string;
  importedNames: string[];
  target: string | null;
}

const RULE_REASONS: Record<TransactionArchitectureRule, string> = {
  'application-gateway-application-gateway':
    'An application-scoped transaction gateway cannot compose another domain gateway.',
  'application-gateway-repository':
    'An application-scoped transaction gateway must use its CoreTransactionRunner, not repositories.',
  'operation-service-repository':
    'An Operation Service must use Queries and its own transaction gateway, not repositories.',
  'operation-service-runner':
    'An Operation Service must not receive the raw CoreTransactionRunner.',
  'transaction-scope-application-gateway':
    'A transaction-scoped module cannot open or compose an application-scoped transaction gateway.',
  'transaction-scope-live-event-bus':
    'A transaction-scoped module cannot publish to the live EventBus before commit.',
  'transaction-scope-remote-infrastructure':
    'A transaction-scoped module cannot perform remote infrastructure I/O.',
  'transaction-scope-runner':
    'A transaction-scoped module cannot open a transaction through CoreTransactionRunner.',
  'transaction-scope-service':
    'A transaction-scoped module cannot depend on an application-scoped Service.',
};

/**
 * Exact legacy imports that remain until their Operation Services migrate. Binding names are part
 * of each entry so extending an existing import is still a new architecture violation.
 */
export const TRANSACTION_ARCHITECTURE_ALLOWLIST: readonly AllowlistedTransactionImport[] = [
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['MeltOperationRepository', 'ProofRepository'],
    reason: 'Legacy Melt Operation persistence; remove when MeltOperationService is migrated.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/mint/MintOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['MintOperationRepository', 'ProofRepository'],
    reason: 'Legacy Mint Operation persistence; remove when MintOperationService is migrated.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['ProofRepository', 'ReceiveOperationRepository'],
    reason: 'Legacy Receive persistence; remove with the Receive transaction migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/send/SendOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['ProofRepository', 'SendOperationRepository'],
    reason: 'Legacy Send persistence; remove with the Send transaction migration.',
  },
];

function normalizeRepositoryPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function withoutModuleExtension(modulePath: string): string {
  return modulePath.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function resolveCoreImport(importer: string, importSource: string): string | null {
  if (importSource === '@core') return 'packages/core';
  if (importSource.startsWith('@core/')) {
    return withoutModuleExtension(`packages/core/${importSource.slice('@core/'.length)}`);
  }
  if (!importSource.startsWith('.')) return null;
  return withoutModuleExtension(
    path.posix.normalize(path.posix.join(path.posix.dirname(importer), importSource)),
  );
}

function getImportedNames(clause: string): string[] {
  const names: string[] = [];
  const normalizedClause = clause
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .trim();
  if (normalizedClause.includes('*')) names.push('*');

  const namedImports = normalizedClause.match(/\{([\s\S]*?)\}/)?.[1];
  if (namedImports) {
    for (const importedName of namedImports.split(',')) {
      const name = importedName
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }

  const beforeNamedImports = normalizedClause.split(/[\{*]/, 1)[0]?.replace(/,$/, '').trim();
  if (beforeNamedImports) names.push('default');
  return [...new Set(names)].sort();
}

function collectImportEdges(module: SourceModule): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const importPattern =
    /^[ \t]*import[ \t]+(?!['"])(?:type[ \t]+)?([\s\S]*?)[ \t]+from[ \t]+(['"])([^'"\n]+)\2[ \t]*;?/gm;
  for (const match of module.sourceText.matchAll(importPattern)) {
    const clause = match[1];
    const importSource = match[3];
    if (!clause || !importSource) continue;
    edges.push({
      importer: normalizeRepositoryPath(module.path),
      importSource,
      importedNames: getImportedNames(clause),
      target: resolveCoreImport(module.path, importSource),
    });
  }
  return edges;
}

function isTransactionScopedImplementation(importer: string): boolean {
  return /^packages\/core\/transactions\/(?:.+\/)?Transactional[^/]*Operations\.ts$/.test(importer);
}

function isApplicationTransactionImplementation(importer: string): boolean {
  if (!importer.startsWith('packages/core/transactions/')) return false;
  const filename = path.posix.basename(importer);
  return !filename.startsWith('Transactional') && filename.endsWith('Transactions.ts');
}

function isOperationService(importer: string): boolean {
  return /^packages\/core\/operations\/(?:.+\/)?[^/]*OperationService\.ts$/.test(importer);
}

function isPathWithin(target: string | null, directory: string): boolean {
  return target === directory || target?.startsWith(`${directory}/`) === true;
}

function importsApplicationTransactionGateway(edge: ImportEdge): boolean {
  if (!edge.target || !edge.target.startsWith('packages/core/transactions/')) return false;
  const filename = path.posix.basename(edge.target);
  const directGateway = !filename.startsWith('Transactional') && filename.endsWith('Transactions');
  const gatewayFromBarrel = edge.importedNames.some((name) => name.endsWith('Transactions'));
  return directGateway || gatewayFromBarrel;
}

function importsLiveEventBus(edge: ImportEdge): boolean {
  return (
    isPathWithin(edge.target, 'packages/core/events') &&
    edge.importedNames.some((name) => name === '*' || name === 'EventBus')
  );
}

function importsCoreTransactionRunner(edge: ImportEdge): boolean {
  if (!edge.target) return false;
  const transactionModule =
    edge.target === 'packages/core/transactions/CoreTransaction' ||
    edge.target === 'packages/core/transactions' ||
    edge.target.endsWith('/transactions/index');
  return (
    transactionModule &&
    edge.importedNames.some(
      (name) =>
        name === '*' ||
        name === 'CoreTransactionRunner' ||
        name === 'RepositoryCoreTransactionRunner',
    )
  );
}

function addViolation(
  violations: TransactionArchitectureViolation[],
  rule: TransactionArchitectureRule,
  edge: ImportEdge,
): void {
  violations.push({
    rule,
    importer: edge.importer,
    importSource: edge.importSource,
    importedNames: edge.importedNames,
    reason: RULE_REASONS[rule],
  });
}

function violationsForEdge(edge: ImportEdge): TransactionArchitectureViolation[] {
  const violations: TransactionArchitectureViolation[] = [];

  if (isTransactionScopedImplementation(edge.importer)) {
    if (isPathWithin(edge.target, 'packages/core/services')) {
      addViolation(violations, 'transaction-scope-service', edge);
    }
    if (isPathWithin(edge.target, 'packages/core/infra')) {
      addViolation(violations, 'transaction-scope-remote-infrastructure', edge);
    }
    if (importsLiveEventBus(edge)) {
      addViolation(violations, 'transaction-scope-live-event-bus', edge);
    }
    if (importsApplicationTransactionGateway(edge)) {
      addViolation(violations, 'transaction-scope-application-gateway', edge);
    }
    if (importsCoreTransactionRunner(edge)) {
      addViolation(violations, 'transaction-scope-runner', edge);
    }
  }

  if (isApplicationTransactionImplementation(edge.importer)) {
    if (isPathWithin(edge.target, 'packages/core/repositories')) {
      addViolation(violations, 'application-gateway-repository', edge);
    }
    if (importsApplicationTransactionGateway(edge)) {
      addViolation(violations, 'application-gateway-application-gateway', edge);
    }
  }

  if (isOperationService(edge.importer)) {
    if (isPathWithin(edge.target, 'packages/core/repositories')) {
      addViolation(violations, 'operation-service-repository', edge);
    }
    if (importsCoreTransactionRunner(edge)) {
      addViolation(violations, 'operation-service-runner', edge);
    }
  }

  return violations;
}

function violationKey(
  violation: Pick<
    TransactionArchitectureViolation,
    'rule' | 'importer' | 'importSource' | 'importedNames'
  >,
): string {
  return [
    violation.rule,
    violation.importer,
    violation.importSource,
    [...violation.importedNames].sort().join(','),
  ].join('|');
}

export function checkTransactionArchitecture(
  modules: readonly SourceModule[],
  allowlist: readonly AllowlistedTransactionImport[] = TRANSACTION_ARCHITECTURE_ALLOWLIST,
): TransactionArchitectureResult {
  const violations = modules
    .flatMap(collectImportEdges)
    .flatMap(violationsForEdge)
    .sort((left, right) => violationKey(left).localeCompare(violationKey(right)));
  const allowlistKeys = new Set(allowlist.map(violationKey));
  const violationKeys = new Set(violations.map(violationKey));

  return {
    violations,
    allowedViolations: violations.filter((violation) => allowlistKeys.has(violationKey(violation))),
    unexpectedViolations: violations.filter(
      (violation) => !allowlistKeys.has(violationKey(violation)),
    ),
    staleAllowlist: allowlist.filter((entry) => !violationKeys.has(violationKey(entry))),
  };
}

export async function loadCoreSourceModules(
  repositoryRoot: string = REPOSITORY_ROOT,
): Promise<SourceModule[]> {
  const modules: SourceModule[] = [];
  const glob = new Bun.Glob('packages/core/**/*.ts');
  for await (const file of glob.scan({ cwd: repositoryRoot, onlyFiles: true })) {
    const normalizedFile = normalizeRepositoryPath(file);
    if (normalizedFile.includes('/test/') || normalizedFile.endsWith('.d.ts')) continue;
    modules.push({
      path: normalizedFile,
      sourceText: await Bun.file(path.join(repositoryRoot, normalizedFile)).text(),
    });
  }
  return modules.sort((left, right) => left.path.localeCompare(right.path));
}

function formatViolation(violation: TransactionArchitectureViolation): string {
  const imports = violation.importedNames.join(', ');
  return `- [${violation.rule}] ${violation.importer} imports { ${imports} } from '${violation.importSource}'\n  ${violation.reason}`;
}

async function main(): Promise<void> {
  const modules = await loadCoreSourceModules();
  const result = checkTransactionArchitecture(modules);

  if (result.unexpectedViolations.length === 0 && result.staleAllowlist.length === 0) {
    console.log(
      `Transaction architecture check passed (${result.allowedViolations.length} allowlisted legacy imports).`,
    );
    return;
  }

  if (result.unexpectedViolations.length > 0) {
    console.error('Unexpected transaction architecture imports:\n');
    console.error(result.unexpectedViolations.map(formatViolation).join('\n'));
  }
  if (result.staleAllowlist.length > 0) {
    console.error('\nStale transaction architecture allowlist entries (remove them):\n');
    console.error(
      result.staleAllowlist
        .map((entry) => `- ${violationKey(entry)}\n  ${entry.reason}`)
        .join('\n'),
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
