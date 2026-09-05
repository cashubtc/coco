#!/usr/bin/env bun

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

export type TransactionArchitectureRule =
  | 'application-gateway-application-gateway'
  | 'application-gateway-live-event-bus'
  | 'application-gateway-remote-infrastructure'
  | 'application-gateway-repository'
  | 'application-gateway-service'
  | 'operation-service-foreign-application-gateway'
  | 'operation-service-repository'
  | 'operation-service-runner'
  | 'operation-service-service'
  | 'operation-service-scoped-commands'
  | 'transaction-scope-application-gateway'
  | 'transaction-scope-live-event-bus'
  | 'transaction-scope-remote-infrastructure'
  | 'transaction-scope-runner'
  | 'transaction-scope-service'
  | 'transaction-scope-root-repositories'
  | 'read-capability-effect'
  | 'transaction-entry-owner'
  | 'nested-transaction-call'
  | 'restricted-effect';

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
  dependencyPath?: string[];
}

export interface AllowlistedTransactionImport {
  rule: TransactionArchitectureRule;
  importer: string;
  importSource: string;
  importedNames: string[];
  reason: string;
  dependencyPath?: string[];
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
  typeOnly?: boolean;
  reExport?: boolean;
}

const RULE_REASONS: Record<TransactionArchitectureRule, string> = {
  'transaction-scope-root-repositories':
    'Scoped code may use scoped repository contracts, never the root Repositories container or concrete adapters.',
  'read-capability-effect':
    'Queries and preflight capabilities cannot acquire Wallet mutation, transaction, Service, or remote authority.',
  'transaction-entry-owner':
    'Only gateways and transaction infrastructure may acquire a runner or open repository transactions.',
  'nested-transaction-call':
    'A gateway runner callback cannot invoke another runner; compose scoped commands instead.',
  'restricted-effect':
    'Transaction and read-capability code cannot perform network I/O, open transactions, or load uninspectable dependencies.',
  'application-gateway-application-gateway':
    'An application-scoped transaction gateway cannot compose another domain gateway.',
  'application-gateway-live-event-bus':
    'An application-scoped transaction gateway must return after commit, not publish live events.',
  'application-gateway-remote-infrastructure':
    'An application-scoped transaction gateway cannot perform remote infrastructure I/O.',
  'application-gateway-repository':
    'An application-scoped transaction gateway must use its CoreTransactionRunner, not repositories.',
  'application-gateway-service':
    'An application-scoped transaction gateway is a leaf adapter and cannot depend on an application-scoped Service.',
  'operation-service-foreign-application-gateway':
    "An Operation Service can use only its own domain's application-scoped transaction gateway.",
  'operation-service-repository':
    'An Operation Service must use Queries and its own transaction gateway, not repositories.',
  'operation-service-runner':
    'An Operation Service must not receive the raw CoreTransactionRunner.',
  'operation-service-service':
    'An Operation Service must use narrow Queries, local capabilities, and remote interfaces instead of broad Services.',
  'operation-service-scoped-commands':
    'An Operation Service must call its gateway rather than receive live transaction-scoped commands.',
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
 * Exact legacy imports that remain until their owning modules migrate. Binding names are part of
 * each entry so extending an existing import is still a new architecture violation.
 */
export const TRANSACTION_ARCHITECTURE_ALLOWLIST: readonly AllowlistedTransactionImport[] = [
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/MintService',
    importedNames: ['MintService'],
    dependencyPath: [
      'packages/core/operations/melt/MeltOperationService.ts',
      'packages/core/operations/melt/MeltMethodHandler.ts',
    ],
    reason: 'Legacy Melt handler authority; remove with the Melt handler migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/ProofService',
    importedNames: ['ProofService'],
    dependencyPath: [
      'packages/core/operations/melt/MeltOperationService.ts',
      'packages/core/operations/melt/MeltMethodHandler.ts',
    ],
    reason: 'Legacy Melt handler authority; remove with the Melt handler migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/WalletService',
    importedNames: ['WalletService'],
    dependencyPath: [
      'packages/core/operations/melt/MeltOperationService.ts',
      'packages/core/operations/melt/MeltMethodHandler.ts',
    ],
    reason: 'Legacy Melt handler authority; remove with the Melt handler migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['ProofRepository'],
    dependencyPath: [
      'packages/core/operations/melt/MeltOperationService.ts',
      'packages/core/operations/melt/MeltMethodHandler.ts',
    ],
    reason:
      'Legacy Melt handler dependency bundle; remove when handler effects are separated during Melt migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['MeltOperationRepository', 'ProofRepository'],
    reason: 'Legacy Melt Operation persistence; remove when MeltOperationService is migrated.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/MintService',
    importedNames: ['MintService'],
    reason: 'Legacy broad Mint dependency; replace with narrow interfaces during Melt migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/ProofService',
    importedNames: ['ProofService'],
    reason: 'Legacy broad Proof dependency; replace with narrow interfaces during Melt migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/melt/MeltOperationService.ts',
    importSource: '../../services/WalletService',
    importedNames: ['WalletService'],
    reason: 'Legacy broad Wallet dependency; replace with narrow interfaces during Melt migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/mint/MintOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['MintOperationRepository', 'ProofRepository'],
    reason: 'Legacy Mint Operation persistence; remove when MintOperationService is migrated.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/mint/MintOperationService.ts',
    importSource: '../../services/MintService',
    importedNames: ['MintService'],
    reason: 'Legacy broad Mint dependency; replace with narrow interfaces during Mint migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/mint/MintOperationService.ts',
    importSource: '../../services/ProofService',
    importedNames: ['ProofService'],
    reason: 'Legacy broad Proof dependency; replace with narrow interfaces during Mint migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/mint/MintOperationService.ts',
    importSource: '../../services/WalletService',
    importedNames: ['WalletService'],
    reason: 'Legacy broad Wallet dependency; replace with narrow interfaces during Mint migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['ProofRepository', 'ReceiveOperationRepository'],
    reason: 'Legacy Receive persistence; remove with the Receive transaction migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../services/MintService',
    importedNames: ['MintService'],
    reason:
      'Legacy broad Mint dependency; replace with narrow interfaces during Receive migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../services/ProofService',
    importedNames: ['ProofService'],
    reason:
      'Legacy broad Proof dependency; replace with narrow interfaces during Receive migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../services/TokenService',
    importedNames: ['TokenService'],
    reason:
      'Legacy broad Token dependency; replace with a narrow capability during Receive migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/receive/ReceiveOperationService.ts',
    importSource: '../../services/WalletService',
    importedNames: ['WalletService'],
    reason:
      'Legacy broad Wallet dependency; replace with narrow interfaces during Receive migration.',
  },
  {
    rule: 'operation-service-repository',
    importer: 'packages/core/operations/send/SendOperationService.ts',
    importSource: '../../repositories',
    importedNames: ['ProofRepository', 'SendOperationRepository'],
    reason: 'Legacy Send persistence; remove with the Send transaction migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/send/SendOperationService.ts',
    importSource: '../../services/MintService',
    importedNames: ['MintService'],
    reason: 'Legacy broad Mint dependency; replace with narrow interfaces during Send migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/send/SendOperationService.ts',
    importSource: '../../services/ProofService',
    importedNames: ['ProofService'],
    reason: 'Legacy broad Proof dependency; replace with narrow interfaces during Send migration.',
  },
  {
    rule: 'operation-service-service',
    importer: 'packages/core/operations/send/SendOperationService.ts',
    importSource: '../../services/WalletService',
    importedNames: ['WalletService'],
    reason: 'Legacy broad Wallet dependency; replace with narrow interfaces during Send migration.',
  },
];

function normalizeRepositoryPath(filePath: string): string {
  return filePath.split(path.sep).join('/').replace(/^\.\//, '');
}

function withoutModuleExtension(modulePath: string): string {
  return modulePath.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

function resolveCoreImport(importer: string, importSource: string): string | null {
  if (importSource === '@cashu/coco-core') return 'packages/core/index';
  if (importSource === '@cashu/coco-core/adapter') return 'packages/core/adapter';
  if (importSource === '@cashu/coco-core/plugin') return 'packages/core/plugin';
  if (importSource === '@core') return 'packages/core';
  if (importSource.startsWith('@core/')) {
    return withoutModuleExtension(`packages/core/${importSource.slice('@core/'.length)}`);
  }
  if (!importSource.startsWith('.')) return null;
  return withoutModuleExtension(
    path.posix.normalize(path.posix.join(path.posix.dirname(importer), importSource)),
  );
}

function collectImportEdges(module: SourceModule): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const source = ts.createSourceFile(module.path, module.sourceText, ts.ScriptTarget.Latest, true);
  const add = (specifier: string, names: string[], typeOnly = false, reExport = false) =>
    edges.push({
      importer: normalizeRepositoryPath(module.path),
      importSource: specifier,
      importedNames: [...new Set(names)].sort(),
      target: resolveCoreImport(module.path, specifier),
      typeOnly,
      reExport,
    });
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name) names.push('default');
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        names.push(...bindings.elements.map((item) => (item.propertyName ?? item.name).text));
      } else if (bindings) names.push('*');
      add(
        node.moduleSpecifier.text,
        names.length ? names : ['*'],
        clause?.isTypeOnly === true ||
          (bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            !clause?.name &&
            bindings.elements.every((item) => item.isTypeOnly)),
      );
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const bindings = node.exportClause;
      add(
        node.moduleSpecifier.text,
        bindings && ts.isNamedExports(bindings)
          ? bindings.elements.map((item) => (item.propertyName ?? item.name).text)
          : ['*'],
        node.isTypeOnly ||
          (bindings !== undefined &&
            ts.isNamedExports(bindings) &&
            bindings.elements.every((item) => item.isTypeOnly)),
        true,
      );
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      add(node.argument.literal.text, [node.qualifier?.getText(source).split('.')[0] ?? '*'], true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) add(argument.text, ['*']);
      else add('<dynamic dependency>', ['*']);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression.text, ['*']);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}
function isTransactionScopedImplementation(importer: string): boolean {
  return (
    importer.startsWith('packages/core/transactions/scoped/') ||
    /^packages\/core\/transactions\/(?:.+\/)?TransactionScoped[^/]*Commands\.ts$/.test(importer)
  );
}

function isApplicationTransactionImplementation(importer: string): boolean {
  if (
    !importer.startsWith('packages/core/transactions/') ||
    isTransactionScopedImplementation(importer)
  )
    return false;
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
  if (!isPathWithin(edge.target, 'packages/core/transactions') || edge.target?.includes('/scoped/'))
    return false;
  if (
    edge.importedNames.includes('*') &&
    (edge.target === 'packages/core/transactions' ||
      edge.target === 'packages/core/transactions/index')
  )
    return true;
  const filename = path.posix.basename(edge.target!);
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

function operationServiceDomain(importer: string): string | null {
  return importer.match(/^packages\/core\/operations\/([^/]+)\//)?.[1] ?? null;
}

function transactionGatewayDomain(edge: ImportEdge): string | null {
  return edge.target?.match(/^packages\/core\/transactions\/([^/]+)\//)?.[1] ?? null;
}

function isReadCapability(importer: string): boolean {
  return (
    importer.startsWith('packages/core/keypairs/') ||
    importer.startsWith('packages/core/queries/') ||
    importer.startsWith('packages/core/capabilities/')
  );
}

function importsRootRepositories(edge: ImportEdge): boolean {
  return (
    /^@cashu\/coco-(?:sqlite|sqlite-bun|indexeddb|expo-sqlite|sql-storage)$/.test(
      edge.importSource,
    ) ||
    (edge.target === 'packages/core/adapter' &&
      edge.importedNames.some((name) => name === '*' || name.endsWith('Repositories'))) ||
    (isPathWithin(edge.target, 'packages/core/repositories') &&
      (edge.typeOnly !== true ||
        edge.target?.includes('/memory') === true ||
        edge.importedNames.some(
          (name) => name === '*' || name === 'Repositories' || name.endsWith('Repositories'),
        )))
  );
}

function importsService(edge: ImportEdge): boolean {
  return (
    isPathWithin(edge.target, 'packages/core/services') ||
    (isPathWithin(edge.target, 'packages/core/operations') &&
      (edge.target?.endsWith('OperationService') === true ||
        edge.importedNames.some((name) => name.endsWith('OperationService'))))
  );
}

function operationGatewayName(domain: string): string {
  const normalizedDomain = domain
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  return `${normalizedDomain}Transactions`;
}

function importsForeignApplicationTransactionGateway(edge: ImportEdge): boolean {
  if (!importsApplicationTransactionGateway(edge)) return false;

  const operationDomain = operationServiceDomain(edge.importer);
  if (!operationDomain) return true;

  const gatewayDomain = transactionGatewayDomain(edge);
  if (gatewayDomain) return gatewayDomain !== operationDomain;

  const ownGatewayName = operationGatewayName(operationDomain);
  return edge.importedNames.some(
    (name) => name === '*' || (name.endsWith('Transactions') && name !== ownGatewayName),
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
    if (importsRootRepositories(edge)) {
      addViolation(violations, 'transaction-scope-root-repositories', edge);
    }
    if (importsService(edge)) {
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
    if (importsService(edge)) {
      addViolation(violations, 'application-gateway-service', edge);
    }
    if (isPathWithin(edge.target, 'packages/core/infra')) {
      addViolation(violations, 'application-gateway-remote-infrastructure', edge);
    }
    if (importsLiveEventBus(edge)) {
      addViolation(violations, 'application-gateway-live-event-bus', edge);
    }
    if (isPathWithin(edge.target, 'packages/core/repositories') || importsRootRepositories(edge)) {
      addViolation(violations, 'application-gateway-repository', edge);
    }
    if (importsApplicationTransactionGateway(edge)) {
      addViolation(violations, 'application-gateway-application-gateway', edge);
    }
  }

  if (isOperationService(edge.importer)) {
    if (
      edge.target?.includes('/transactions/scoped/') ||
      (edge.target === 'packages/core/transactions/CoreTransaction' &&
        edge.importedNames.includes('CoreTransaction'))
    ) {
      addViolation(violations, 'operation-service-scoped-commands', edge);
    }
    if (importsService(edge)) {
      addViolation(violations, 'operation-service-service', edge);
    }
    if (importsForeignApplicationTransactionGateway(edge)) {
      addViolation(violations, 'operation-service-foreign-application-gateway', edge);
    }
    if (isPathWithin(edge.target, 'packages/core/repositories') || importsRootRepositories(edge)) {
      addViolation(violations, 'operation-service-repository', edge);
    }
    if (importsCoreTransactionRunner(edge)) {
      addViolation(violations, 'operation-service-runner', edge);
    }
  }

  if (
    isReadCapability(edge.importer) &&
    (importsService(edge) ||
      isPathWithin(edge.target, 'packages/core/infra') ||
      isPathWithin(edge.target, 'packages/core/repositories') ||
      importsRootRepositories(edge) ||
      isPathWithin(edge.target, 'packages/core/transactions') ||
      importsLiveEventBus(edge))
  )
    addViolation(violations, 'read-capability-effect', edge);

  return violations;
}

function violationKey(
  violation: Pick<
    TransactionArchitectureViolation,
    'rule' | 'importer' | 'importSource' | 'importedNames' | 'dependencyPath'
  >,
): string {
  return [
    violation.rule,
    violation.importer,
    violation.importSource,
    [...violation.importedNames].sort().join(','),
    violation.dependencyPath && violation.dependencyPath.length > 1
      ? violation.dependencyPath.join(' -> ')
      : '',
  ].join('|');
}

/** Explicit infrastructure exceptions; helpers cannot make themselves transaction owners. */
function isTransactionInfrastructure(file: string): boolean {
  return (
    file === 'packages/core/Manager.ts' ||
    file === 'packages/core/transactions/CoreTransaction.ts' ||
    file.startsWith('packages/core/repositories/')
  );
}

function isRestricted(file: string): boolean {
  return (
    isTransactionScopedImplementation(file) ||
    isApplicationTransactionImplementation(file) ||
    isReadCapability(file)
  );
}

function sourceEffects(module: SourceModule, owner: string): TransactionArchitectureViolation[] {
  const result: TransactionArchitectureViolation[] = [];
  const source = ts.createSourceFile(module.path, module.sourceText, ts.ScriptTarget.Latest, true);
  const record = (rule: TransactionArchitectureRule, name: string) =>
    addViolation(result, rule, {
      importer: owner,
      importSource: module.path,
      importedNames: [name],
      target: null,
    });
  const visit = (node: ts.Node): void => {
    // Also catches extracting/binding the method before calling it.
    const member = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    if (member === 'withTransaction' && !isTransactionInfrastructure(owner)) {
      record('transaction-entry-owner', member);
    }
    if (
      isApplicationTransactionImplementation(owner) &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'run'
    ) {
      const inspectCallback = (child: ts.Node): void => {
        if (
          ts.isCallExpression(child) &&
          ts.isPropertyAccessExpression(child.expression) &&
          child.expression.name.text === 'run'
        )
          record('nested-transaction-call', 'run');
        ts.forEachChild(child, inspectCallback);
      };
      for (const argument of node.arguments) inspectCallback(argument);
    }
    if (isRestricted(owner) && ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : null;
      if (name === 'fetch') record('restricted-effect', name);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'withTransaction' &&
      !isTransactionInfrastructure(owner)
    ) {
      record('transaction-entry-owner', 'withTransaction');
    }
    if (
      isRestricted(owner) &&
      ts.isNewExpression(node) &&
      ['WebSocket', 'XMLHttpRequest'].includes(node.expression.getText(source))
    ) {
      record('restricted-effect', node.expression.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

function dependencyViolations(
  modules: readonly SourceModule[],
): TransactionArchitectureViolation[] {
  const moduleMap = new Map(modules.map((module) => [withoutModuleExtension(module.path), module]));
  const edgeMap = new Map(modules.map((module) => [module.path, collectImportEdges(module)]));
  const result: TransactionArchitectureViolation[] = [];
  for (const root of modules) {
    const visit = (module: SourceModule, chain: string[], exportsOnly = false): void => {
      // Break cycles per path, not per root: a second path to the same forbidden dependency
      // must not inherit an exception granted to the first path.
      if (chain.slice(0, -1).includes(module.path)) return;
      if (!exportsOnly)
        result.push(
          ...sourceEffects(module, root.path).map((item) => ({ ...item, dependencyPath: chain })),
        );
      for (const edge of edgeMap.get(module.path) ?? []) {
        if (exportsOnly && !edge.reExport) continue;
        const effectiveEdge = { ...edge, importer: root.path };
        const violations = violationsForEdge(effectiveEdge);
        if (
          importsCoreTransactionRunner(edge) &&
          !isTransactionInfrastructure(root.path) &&
          !isApplicationTransactionImplementation(root.path) &&
          violations.length === 0
        ) {
          addViolation(violations, 'transaction-entry-owner', effectiveEdge);
        }
        if (
          isRestricted(root.path) &&
          (edge.importSource === '<dynamic dependency>' ||
            /^(?:node:)?(?:https?|net|tls)$/.test(edge.importSource) ||
            ['axios', 'undici', 'ws'].includes(edge.importSource) ||
            (edge.importSource === '@cashu/cashu-ts' &&
              edge.importedNames.some((name) => ['Wallet', 'Mint', '*'].includes(name))))
        )
          addViolation(violations, 'restricted-effect', effectiveEdge);
        result.push(...violations.map((item) => ({ ...item, dependencyPath: chain })));
        if (violations.length || !edge.target) continue;

        // These are separately checked architectural seams. Do not interpret a permitted
        // interface import as granting its consumer all of its implementation dependencies.
        if (
          isPathWithin(edge.target, 'packages/core/repositories') ||
          isPathWithin(edge.target, 'packages/core/services') ||
          isPathWithin(edge.target, 'packages/core/infra') ||
          edge.target === 'packages/core/transactions/CoreTransaction' ||
          importsApplicationTransactionGateway(edge) ||
          (isApplicationTransactionImplementation(root.path) &&
            edge.target.includes('/transactions/scoped/'))
        )
          continue;
        const target = moduleMap.get(edge.target) ?? moduleMap.get(`${edge.target}/index`);
        if (target) visit(target, [...chain, target.path], edge.typeOnly === true);
      }
    };
    // Legacy application code is checked directly; scoped, gateway, capability, and operation
    // roots additionally carry their restrictions through arbitrary local helper/re-export chains.
    if (isRestricted(root.path) || isOperationService(root.path)) visit(root, [root.path]);
    else {
      result.push(...sourceEffects(root, root.path));
      for (const edge of edgeMap.get(root.path) ?? []) {
        if (importsCoreTransactionRunner(edge) && !isTransactionInfrastructure(root.path)) {
          addViolation(result, 'transaction-entry-owner', edge);
        }
      }
    }
  }
  return [...new Map(result.map((item) => [violationKey(item), item])).values()];
}

export function checkTransactionArchitecture(
  modules: readonly SourceModule[],
  allowlist: readonly AllowlistedTransactionImport[] = TRANSACTION_ARCHITECTURE_ALLOWLIST,
): TransactionArchitectureResult {
  const violations = dependencyViolations(modules).sort((left, right) =>
    violationKey(left).localeCompare(violationKey(right)),
  );
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
    if (
      normalizedFile.includes('/test/') ||
      normalizedFile.includes('/node_modules/') ||
      normalizedFile.includes('/dist/') ||
      normalizedFile.endsWith('.d.ts')
    )
      continue;
    modules.push({
      path: normalizedFile,
      sourceText: await Bun.file(path.join(repositoryRoot, normalizedFile)).text(),
    });
  }
  return modules.sort((left, right) => left.path.localeCompare(right.path));
}

function formatViolation(violation: TransactionArchitectureViolation): string {
  const imports = violation.importedNames.join(', ');
  const via =
    violation.dependencyPath && violation.dependencyPath.length > 1
      ? `\n  via ${violation.dependencyPath.join(' -> ')}`
      : '';
  return `- [${violation.rule}] ${violation.importer} imports { ${imports} } from '${violation.importSource}'\n  ${violation.reason}${via}`;
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
